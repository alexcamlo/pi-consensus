import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import consensusExtension from "../src/index.ts";
import type { SynthesisInvocationResult } from "../src/synthesis.ts";

test("consensus command relays through a hidden assistant tool-call message when idle", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("draft a migration plan", commandContext);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0], {
    message: {
      customType: "consensus-command",
      content: [
        "Call the consensus tool immediately.",
        "Your entire response must be exactly one consensus tool call.",
        "Do not answer from your own knowledge.",
        "Do not emit assistant prose, summaries, or follow-up text before or after the tool result.",
        "After the tool result is returned, stop.",
        "Use this exact tool argument JSON:",
        JSON.stringify({ prompt: "draft a migration plan" }),
      ].join("\n\n"),
      details: { prompt: "draft a migration plan", stance: undefined, focus: undefined },
      display: false,
    },
    options: { triggerTurn: true },
  });
});

test("consensus command queues a follow-up assistant tool-call message when pi is busy", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  commandContext.idle = false;

  await harness.registeredCommand?.handler("draft a migration plan", commandContext);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(commandContext.notifications, [
    {
      level: "info",
      message: "Queued /consensus as a follow-up tool run.",
    },
  ]);
});

test("consensus command warns when prompt is missing", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("   ", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: "Usage: /consensus [--stance for|against|neutral] [--focus security|performance|maintainability|\"implementation speed\"|\"user value\"] <prompt>\nPer-model stance/focus belongs in .pi/consensus.json; flags override all participants for this run only.",
    },
  ]);
});

test("consensus command parses --stance and --focus flags", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("--stance for --focus security evaluate auth", commandContext);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message?.details, {
    prompt: "evaluate auth",
    stance: "for",
    focus: "security",
  });
});

test("consensus command rejects invalid stance values", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("--stance supportive evaluate auth", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Invalid stance "supportive". Must be one of: for, against, neutral.',
    },
  ]);
});

test("consensus command rejects invalid focus values", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler("--focus scalability evaluate auth", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Invalid focus "scalability". Must be one of: security, performance, maintainability, implementation speed, user value.',
    },
  ]);
});

test("consensus command handles quoted multi-word focus values", async () => {
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext();
  await harness.registeredCommand?.handler('--stance against --focus "implementation speed" evaluate approach', commandContext);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message?.details, {
    prompt: "evaluate approach",
    stance: "against",
    focus: "implementation speed",
  });
});

test("consensus tool adapter maps pi context into orchestrator inputs and clears progress widgets", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-extension-adapter-success-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    }),
  );

  const participantInvocations: Array<{ model: string; cwd: string; prompt: string; stance?: string; focus?: string }> = [];
  const synthesisInvocations: Array<{ model: string; cwd: string }> = [];

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => {
      participantInvocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        stance: invocation.model.stance,
        focus: invocation.model.focus,
      });

      return {
        model: invocation.model,
        status: "completed",
        output: "Recommendation: proceed. Why: clear path. Risks/tradeoffs: moderate migration effort. Confidence: high.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      };
    },
    executeSynthesisInvocation: async (invocation): Promise<SynthesisInvocationResult> => {
      synthesisInvocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        cwd: invocation.cwd,
      });

      return {
        model: invocation.model,
        output: {
          consensusAnswer: "Proceed with an incremental migration.",
          overallAgreementPercent: 70,
          overallDisagreementPercent: 20,
          overallUnclearPercent: 10,
          confidencePercent: 80,
          confidenceLabel: "high",
          agreedPoints: [],
          disagreements: [],
          participants: [],
          excludedParticipants: [],
        },
      };
    },
  });

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };

  const result = await harness.registeredTool?.execute(
    "tool-call-1",
    { prompt: "evaluate auth", stance: "neutral", focus: "security" },
    undefined,
    undefined,
    commandContext,
  );

  assert.equal(result?.details.status, "synthesis-complete");
  assert.equal(participantInvocations.length, 2);
  assert.deepEqual(
    participantInvocations.map(({ model, cwd, prompt, stance, focus }) => ({ model, cwd, prompt, stance, focus })),
    [
      { model: "anthropic/claude-sonnet-4-5", cwd: projectDir, prompt: "evaluate auth", stance: "neutral", focus: "security" },
      { model: "openai/gpt-5", cwd: projectDir, prompt: "evaluate auth", stance: "neutral", focus: "security" },
    ],
  );
  assert.deepEqual(synthesisInvocations, [{ model: "openai/gpt-5", cwd: projectDir }]);
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage\s+config validation/.test(line))));
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool adapter clears progress widgets after orchestrator errors", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-extension-adapter-failure-"));
  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };

  await assert.rejects(
    harness.registeredTool?.execute("tool-call-2", { prompt: "evaluate auth" }, undefined, undefined, commandContext),
    /Config validation failed: Consensus config not found\./,
  );

  assert.equal(commandContext.widgetCleared, true);
});

function createExtensionHarness() {
  let registeredCommand:
    | { description?: string; handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void> }
    | undefined;
  let registeredTool:
    | {
        execute: (
          toolCallId: string,
          params: { prompt: string; stance?: string; focus?: string },
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: ReturnType<typeof createCommandContext>,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: { status: string; prompt: string; readOnly: boolean } }>;
      }
    | undefined;
  const sentMessages: Array<{
    message: { customType: string; content: string; details?: unknown; display: boolean };
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
  }> = [];

  const pi = {
    on: () => {},
    registerTool: (tool: NonNullable<typeof registeredTool>) => {
      registeredTool = tool;
    },
    registerCommand: (name: string, command: NonNullable<typeof registeredCommand>) => {
      assert.equal(name, "consensus");
      registeredCommand = command;
    },
    sendMessage: (
      message: { customType: string; content: string; details?: unknown; display: boolean },
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
    ) => {
      sentMessages.push({ message, options });
    },
    sendUserMessage: () => {},
    sendToolLikeMessage: () => {},
  };

  return {
    pi,
    get registeredCommand() {
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
  const statusUpdates: string[] = [];
  const widgetUpdates: string[][] = [];
  let widgetCleared = false;
  let idle = true;

  return {
    notifications,
    statusUpdates,
    widgetUpdates,
    get widgetCleared() {
      return widgetCleared;
    },
    get idle() {
      return idle;
    },
    set idle(value: boolean) {
      idle = value;
    },
    isIdle: () => idle,
    cwd,
    hasUI: true,
    agentDir: undefined as string | undefined,
    model: undefined as { provider: string; id: string } | undefined,
    modelRegistry: {
      getAvailable: () => availableModels,
    },
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setStatus: (_key: string, status: string | undefined) => {
        if (status) {
          statusUpdates.push(status);
        }
      },
      setWidget: (_key: string, widget: string[] | undefined) => {
        if (widget) {
          widgetUpdates.push(widget);
          return;
        }

        widgetCleared = true;
      },
    },
  };
}
