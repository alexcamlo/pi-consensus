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

  // Use a worktree-backed temp branch.
  sandbox: docker(),
  branchStrategy: { type: "merge-to-head" },

  // The agent provider. Use an env-backed model for Sandcastle so sandbox runs
  // do not depend on interactive subscription auth.
  agent: pi("openrouter/moonshotai/kimi-k2.5"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 8,

  logging: { type: "stdout" },

  // Lifecycle hooks — commands that run inside the sandbox at specific points.
  hooks: {
    // onSandboxReady runs once after the sandbox is initialised and the repo is
    // synced in, before the agent starts. Use it to install dependencies or run
    // any other setup steps your project needs.
    onSandboxReady: [
      {
        command:
          "if [ -f package.json ]; then npm install; else echo 'Skipping npm install: no package.json in sandbox'; fi",
      },
    ],
  },
});
