import { execFileSync } from "node:child_process";
import { pi, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const hasInitialCommit = () => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const warnIfRepoHasNoInitialCommit = () => {
  if (hasInitialCommit()) {
    return;
  }

  console.warn(
    [
      "Sandcastle warning: this repo has no initial commit.",
      "Worktree runs may preserve sandbox worktrees because seeded files appear as uncommitted changes.",
      "Recommended: create an initial commit on your main branch before relying on Sandcastle cleanup behavior.",
    ].join(" "),
  );
};

warnIfRepoHasNoInitialCommit();

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // The agent provider.
  agent: pi("openai-codex/gpt-5.3-codex"),

  // Use a worktree-backed temp branch. Mount the host Pi agent dir read-only,
  // then seed a writable sandbox-local ~/.pi/agent so OAuth lock files and
  // token refreshes never touch the host config directory.
  sandbox: docker({
    mounts: [
      {
        hostPath: "~/.pi/agent",
        sandboxPath: "/mnt/host-pi-agent",
        readonly: true,
      },
    ],
  }),
  branchStrategy: { type: "merge-to-head" },

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue.
  maxIterations: 1,

  // Disable prompt-driven early termination for this provider. Its stdout can
  // include echoed prompt text, so any user-visible completion token becomes a
  // false-positive match. Use an internal sentinel that is never mentioned in
  // the prompt.
  completionSignal: "__SANDCASTLE_INTERNAL_NEVER_EMIT_5b9c7d1f__",

  logging: { type: "stdout" },

  // Lifecycle hooks — commands that run inside the sandbox at specific points.
  hooks: {
    // onSandboxReady runs once after the sandbox is initialised and the repo is
    // synced in, before the agent starts. Use it to install dependencies or run
    // any other setup steps your project needs.
    onSandboxReady: [
      {
        command: [
          "mkdir -p /home/agent/.pi/agent",
          "cp -R /mnt/host-pi-agent/. /home/agent/.pi/agent/",
          "if [ -f /home/agent/.pi/agent/auth.json ]; then chmod 600 /home/agent/.pi/agent/auth.json; else echo 'Missing mounted Pi auth.json in sandbox' >&2; exit 1; fi",
          "if [ -f package.json ]; then npm install; else echo 'Skipping npm install: no package.json in sandbox'; fi",
        ].join(" && "),
      },
    ],
  },
});
