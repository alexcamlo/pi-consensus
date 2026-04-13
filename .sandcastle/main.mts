import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, type AgentProvider } from "@ai-hero/sandcastle";

type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string };
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const PI_AUTH_RUNTIME_PATH = ".sandcastle/.sandcastle-pi-auth.json";
const SANDBOX_PI_AUTH_PATH = "/home/agent/.pi/agent/auth.json";
const SANDBOX_SEED_PATHS = [PI_AUTH_RUNTIME_PATH];
const PI_TOOL_ARG_FIELDS = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
} as const;

const shellEscape = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const createBufferedPiProvider = (model: string): AgentProvider => {
  let pendingText = "";

  const flushPendingText = (force = false): ParsedStreamEvent[] => {
    if (pendingText.length === 0) {
      return [];
    }

    const hasParagraphBreak = pendingText.includes("\n\n");
    const hasLineBreak = pendingText.includes("\n");
    const endsSentence = /[.!?]["')\]]?\s*$/.test(pendingText);
    const longChunk = pendingText.length >= 160;

    if (!force && !hasParagraphBreak && !hasLineBreak && !endsSentence && !longChunk) {
      return [];
    }

    const text = pendingText.trim();
    pendingText = "";
    return text.length > 0 ? [{ type: "text" as const, text }] : [];
  };

  return {
    name: "pi",
    buildPrintCommand(prompt) {
      return `pi -p --mode json --no-session --model ${shellEscape(model)} ${shellEscape(prompt)}`;
    },
    buildInteractiveArgs(_prompt) {
      return ["pi", "--model", model];
    },
    parseStreamLine(line) {
      if (!line.startsWith("{")) {
        return [];
      }

      try {
        const obj = JSON.parse(line);

        if (obj.type === "message_update" && obj.assistantMessageEvent?.type === "text_delta") {
          const delta = obj.assistantMessageEvent.delta;
          if (typeof delta !== "string") {
            return [];
          }

          pendingText += delta;
          return flushPendingText();
        }

        if (obj.type === "tool_execution_start") {
          const toolName = obj.toolName;
          if (typeof toolName !== "string") {
            return flushPendingText(true);
          }

          const argField = PI_TOOL_ARG_FIELDS[toolName as keyof typeof PI_TOOL_ARG_FIELDS];
          if (argField === undefined) {
            return flushPendingText(true);
          }

          const argValue = obj.args?.[argField];
          const events = flushPendingText(true);
          if (typeof argValue === "string") {
            events.push({ type: "tool_call", name: toolName, args: argValue });
          }
          return events;
        }

        if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
          const events = flushPendingText(true);

          for (let i = obj.messages.length - 1; i >= 0; i--) {
            const msg = obj.messages[i];
            if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
              continue;
            }

            const texts = msg.content
              .filter((block: { type?: string; text?: string }) => block.type === "text" && typeof block.text === "string")
              .map((block: { text: string }) => block.text);

            if (texts.length > 0) {
              events.push({ type: "result", result: texts.join("") });
            }
            break;
          }

          return events;
        }
      } catch {
        return [];
      }

      return [];
    },
  };
};

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

const preparePiAuthRuntime = () => {
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");

  if (!existsSync(piAuthPath)) {
    console.warn(
      `Pi auth file not found at ${piAuthPath}. openai-codex runs may fail.`,
    );
    return null;
  }

  mkdirSync(process.cwd(), { recursive: true });
  writeFileSync(
    join(process.cwd(), PI_AUTH_RUNTIME_PATH),
    readFileSync(piAuthPath),
  );
  return PI_AUTH_RUNTIME_PATH;
};

const buildPiAuthCommands = (piAuthRuntimePath: string | null) => {
  if (!piAuthRuntimePath) {
    return [] as { command: string }[];
  }

  return [
    {
      command: [
        `test -f ${shellEscape(piAuthRuntimePath)}`,
        "|| (echo 'Missing staged Pi auth file in sandbox' >&2",
        "&& pwd >&2",
        "&& ls -la >&2",
        "&& exit 1)",
      ].join(" "),
    },
    { command: "mkdir -p /home/agent/.pi/agent" },
    {
      command: `cp ${shellEscape(piAuthRuntimePath)} ${shellEscape(SANDBOX_PI_AUTH_PATH)}`,
    },
    { command: `chmod 600 ${shellEscape(SANDBOX_PI_AUTH_PATH)}` },
  ];
};

warnIfRepoHasNoInitialCommit();
const piAuthRuntimePath = preparePiAuthRuntime();

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Use a worktree-backed temp branch so runtime files can be copied into the sandbox.
  sandbox: docker({ branchStrategy: { type: "merge-to-head" } }),

  // The agent provider. Pass a model string to pi() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-6 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: createBufferedPiProvider("openrouter/moonshotai/kimi-k2.5"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 8,

  copyToSandbox: SANDBOX_SEED_PATHS,
  logging: { type: "stdout" },

  // Lifecycle hooks — commands that run inside the sandbox at specific points.
  hooks: {
    // onSandboxReady runs once after the sandbox is initialised and the repo is
    // synced in, before the agent starts. Use it to install dependencies or run
    // any other setup steps your project needs.
    onSandboxReady: [
      ...buildPiAuthCommands(piAuthRuntimePath),
      {
        command:
          "if [ -f package.json ]; then npm install; else echo 'Skipping npm install: no package.json in sandbox'; fi",
      },
    ],
  },
});
