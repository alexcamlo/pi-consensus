import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import consensusExtension from "../src/index.ts";
import { createConsensusScaffoldResult } from "../src/scaffold.ts";

test("createConsensusScaffoldResult returns read-only placeholder details", () => {
  const result = createConsensusScaffoldResult("review this repo", {
    configPath: ".pi/consensus.json",
    participants: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    synthesisModel: "openai/gpt-5",
    warnings: ["Duplicate participant models were deduplicated."],
  });

  assert.match(result.text, /pi-consensus scaffold is installed\./);
  assert.match(result.text, /Prompt: review this repo/);
  assert.match(result.text, /Config: \.pi\/consensus.json/);
  assert.match(result.text, /Participants: anthropic\/claude-sonnet-4-5, openai\/gpt-5/);
  assert.equal(result.details.status, "scaffolded");
  assert.equal(result.details.prompt, "review this repo");
  assert.equal(result.details.readOnly, true);
  assert.equal(result.details.config?.participants.length, 2);
  assert.ok(result.details.nextSteps.length >= 3);
});

test("consensus command validates config, prefers project config, and reports warnings", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-project-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-consensus-agent-"));

  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-5",
        "openai/gpt-5",
      ],
      synthesisModel: "openai/not-a-real-model",
      participantThinking: "low",
      synthesisThinking: "medium",
      participantTimeoutMs: 120000,
      synthesisTimeoutMs: 90000,
    }),
  );
  writeFileSync(
    join(agentDir, "consensus.json"),
    JSON.stringify({
      models: ["google/gemini-2.5-pro", "openai/gpt-5"],
      synthesisModel: "google/gemini-2.5-pro",
    }),
  );

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
    { provider: "google", id: "gemini-2.5-pro" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = agentDir;

  await harness.registeredCommand?.handler("draft a migration plan", commandContext);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0]?.content ?? "", /Config: .*\.pi\/consensus\.json/);
  assert.match(harness.sentMessages[0]?.content ?? "", /Synthesis model: openai\/gpt-5/);
  assert.doesNotMatch(harness.sentMessages[0]?.content ?? "", /google\/gemini-2\.5-pro/);
  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Duplicate participant model "openai/gpt-5" was deduplicated.',
    },
    {
      level: "warning",
      message: 'Configured synthesis model "openai/not-a-real-model" is unavailable; falling back to current model "openai/gpt-5".',
    },
    {
      level: "warning",
      message: 'Synthesis model "openai/gpt-5" is also configured as a participant.',
    },
    {
      level: "info",
      message: "pi-consensus scaffold executed; config validated and multi-model runner not implemented yet.",
    },
  ]);
});

test("consensus command shows a clear error when config is missing", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-missing-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-consensus-agent-missing-"));

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = agentDir;

  await harness.registeredCommand?.handler("draft a migration plan", commandContext);

  assert.equal(harness.sentMessages.length, 0);
  assert.deepEqual(commandContext.notifications, [
    {
      level: "error",
      message:
        "Consensus config not found. Create .pi/consensus.json or ~/.pi/agent/consensus.json with at least 2 participant models.",
    },
  ]);
});

test("consensus tool fails clearly when fewer than two unique participant models remain", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-invalid-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["openai/gpt-5", "openai/gpt-5"],
    }),
  );

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  await assert.rejects(
    harness.registeredTool?.execute(
      "tool-call-1",
      { prompt: "draft a migration plan" },
      undefined,
      undefined,
      {
        cwd: projectDir,
        agentDir: mkdtempSync(join(tmpdir(), "pi-consensus-agent-invalid-")),
        model: { provider: "openai", id: "gpt-5" },
        modelRegistry: {
          getAvailable: () => [{ provider: "openai", id: "gpt-5" }],
        },
      },
    ),
    /Consensus config must contain at least 2 unique participant models\./,
  );
});

test("consensus command warns when prompt is missing", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("   ", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: "Usage: /consensus <prompt>",
    },
  ]);
});

function createExtensionHarness() {
  let registeredCommand:
    | { description?: string; handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void> }
    | undefined;
  let registeredTool:
    | {
        execute: (
          toolCallId: string,
          params: { prompt: string },
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: ReturnType<typeof createCommandContext>,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: { status: string; prompt: string; readOnly: boolean } }>;
      }
    | undefined;
  let registeredMessageType: string | undefined;
  const sentMessages: Array<{ customType: string; content: string; details: unknown; display: boolean }> = [];

  const pi = {
    on: () => {},
    registerMessageRenderer: (messageType: string) => {
      registeredMessageType = messageType;
    },
    registerTool: (tool: NonNullable<typeof registeredTool>) => {
      registeredTool = tool;
    },
    registerCommand: (name: string, command: NonNullable<typeof registeredCommand>) => {
      assert.equal(name, "consensus");
      registeredCommand = command;
    },
    sendMessage: (message: { customType: string; content: string; details: unknown; display: boolean }) => {
      sentMessages.push(message);
    },
  };

  return {
    pi,
    get registeredCommand() {
      assert.equal(registeredMessageType, "consensus-scaffold");
      return registeredCommand;
    },
    get registeredTool() {
      return registeredTool;
    },
    sentMessages,
  };
}

function createCommandContext(
  cwd = process.cwd(),
  availableModels: Array<{ provider: string; id: string }> = [],
) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    cwd,
    agentDir: undefined as string | undefined,
    model: undefined as { provider: string; id: string } | undefined,
    modelRegistry: {
      getAvailable: () => availableModels,
    },
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };
}
