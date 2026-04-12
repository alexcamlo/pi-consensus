import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import consensusExtension from "../src/index.ts";
import { createConsensusExecutionResult } from "../src/result.ts";
import type { SynthesisExecutionResult } from "../src/synthesis.ts";

test("createConsensusExecutionResult returns formatted consensus text with debug participant details", () => {
  const result = createConsensusExecutionResult(
    "review this repo",
    {
      configPath: ".pi/consensus.json",
      participants: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
      synthesisModel: "openai/gpt-5",
      warnings: ["Duplicate participant models were deduplicated."],
    },
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        status: "usable",
        output: "Inspect src/index.ts first.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      },
      {
        model: "openai/gpt-5",
        status: "excluded",
        output: "I'm sorry, but I can't help with that request.",
        exclusionReason: "refusal-only response",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
      {
        model: "google/gemini-2.5-pro",
        status: "failed",
        failureReason: "participant subprocess exited with code 1",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
    ],
    "Consensus requires at least 2 usable participant outputs but only 1 remained after filtering.",
  );

  assert.match(result.text, /^# Consensus/m);
  assert.match(result.text, /## Prompt\s+review this repo/m);
  assert.match(result.text, /## Excluded\s+- openai\/gpt-5 — refusal-only response\s+- google\/gemini-2\.5-pro — participant subprocess exited with code 1/m);
  assert.match(result.text, /## Debug participant outputs/m);
  assert.match(result.text, /### anthropic\/claude-sonnet-4-5 — usable/m);
  assert.match(result.text, /Inspect src\/index\.ts first\./);
  assert.equal(result.details.status, "participant-pass-insufficient-usable");
  assert.equal(result.details.prompt, "review this repo");
  assert.equal(result.details.readOnly, true);
  assert.equal(result.details.config?.participants.length, 3);
  assert.equal(result.details.participants.length, 3);
  assert.equal(result.details.usableParticipantCount, 1);
  assert.ok(result.details.nextSteps.length >= 2);
});

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
        "Do not answer from your own knowledge.",
        "Do not add assistant prose before or after the tool result.",
        "Use this exact tool argument JSON:",
        JSON.stringify({ prompt: "draft a migration plan" }),
      ].join("\n\n"),
      details: { prompt: "draft a migration plan" },
      display: false,
    },
    options: { triggerTurn: true },
  });
  assert.equal(harness.sentUserMessages.length, 0);
  assert.equal(harness.sentToolLikeMessages.length, 0);
  assert.deepEqual(commandContext.notifications, []);
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

test("consensus tool validates config, runs synthesis with full participant outputs, prefers project config, and reports warnings", async () => {
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
  const participantInvocations: Array<{ model: string; cwd: string; prompt: string; allowedTools: string[]; systemPrompt: string }> = [];
  const synthesisInvocations: Array<{ model: string; cwd: string; prompt: string; allowedTools: string[]; systemPrompt: string }> = [];
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => {
      participantInvocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        allowedTools: invocation.allowedTools,
        systemPrompt: invocation.systemPrompt,
      });

      return {
        model: invocation.model,
        status: "completed",
        output:
          `Recommendation: adopt the ${invocation.model.provider}/${invocation.model.id} migration plan. Why: it keeps the rollout incremental. Risks/tradeoffs: moderate coordination cost. Confidence: 78%.`,
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      };
    },
    executeSynthesisInvocation: async (invocation): Promise<SynthesisExecutionResult> => {
      synthesisInvocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        allowedTools: invocation.allowedTools,
        systemPrompt: invocation.systemPrompt,
      });

      return {
        model: invocation.model,
        output: {
          consensusAnswer: "Use the incremental migration plan.",
          overallAgreementPercent: 70,
          overallDisagreementPercent: 20,
          overallUnclearPercent: 10,
          confidencePercent: 78,
          confidenceLabel: "medium",
          agreedPoints: [
            {
              point: "Roll out the migration incrementally.",
              supportPercent: 100,
              supportingParticipants: 2,
              totalParticipants: 2,
            },
          ],
          disagreements: [
            {
              point: "Whether to automate the final cleanup immediately.",
              summary: "One model prefers delaying cleanup until after validation.",
            },
          ],
          participants: [
            {
              model: "anthropic/claude-sonnet-4-5",
              summary: "Recommended an incremental rollout.",
            },
            {
              model: "openai/gpt-5",
              summary: "Also recommended an incremental rollout.",
            },
          ],
          excludedParticipants: [],
        },
      };
    },
  });

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
    { provider: "google", id: "gemini-2.5-pro" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = agentDir;

  const toolResult = await harness.registeredTool?.execute(
    "tool-call-1",
    { prompt: "draft a migration plan" },
    undefined,
    undefined,
    commandContext,
  );

  const content = toolResult?.content[0]?.text ?? "";
  assert.match(content, /^# Consensus/m);
  assert.match(content, /## Metadata[\s\S]*Config: .*\.pi\/consensus\.json/);
  assert.match(content, /Synthesis model: openai\/gpt-5/);
  assert.match(content, /## Answer\s+Use the incremental migration plan\./m);
  assert.match(content, /- Agreement: 70%/);
  assert.match(content, /- Disagreement: 20%/);
  assert.match(content, /- Unclear: 10%/);
  assert.match(content, /## Participants\s+- anthropic\/claude-sonnet-4-5 — Recommended an incremental rollout\.\s+- openai\/gpt-5 — Also recommended an incremental rollout\./m);
  assert.match(content, /## Debug participant outputs/m);
  assert.match(content, /Recommendation: adopt the anthropic\/claude-sonnet-4-5 migration plan\./);
  assert.match(content, /Recommendation: adopt the openai\/gpt-5 migration plan\./);
  assert.doesNotMatch(content, /google\/gemini-2\.5-pro —/);
  assert.equal((toolResult?.details as { synthesis?: { consensusAnswer?: string } })?.synthesis?.consensusAnswer, "Use the incremental migration plan.");
  assert.deepEqual(
    participantInvocations.map(({ model, cwd, prompt, allowedTools }) => ({ model, cwd, prompt, allowedTools })),
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        cwd: projectDir,
        prompt: "draft a migration plan",
        allowedTools: ["read", "ls", "find", "grep", "multi_grep"],
      },
      {
        model: "openai/gpt-5",
        cwd: projectDir,
        prompt: "draft a migration plan",
        allowedTools: ["read", "ls", "find", "grep", "multi_grep"],
      },
    ],
  );
  assert.match(participantInvocations[0]?.systemPrompt ?? "", /inspect the relevant files before answering/i);
  assert.deepEqual(synthesisInvocations, [
    {
      model: "openai/gpt-5",
      cwd: projectDir,
      prompt:
        'Original user prompt:\n"""\ndraft a migration plan\n"""\n\nUsable participant outputs:\n\nParticipant: anthropic/claude-sonnet-4-5\nRecommendation: adopt the anthropic/claude-sonnet-4-5 migration plan. Why: it keeps the rollout incremental. Risks/tradeoffs: moderate coordination cost. Confidence: 78%.\n\nParticipant: openai/gpt-5\nRecommendation: adopt the openai/gpt-5 migration plan. Why: it keeps the rollout incremental. Risks/tradeoffs: moderate coordination cost. Confidence: 78%.',
      allowedTools: [],
      systemPrompt: synthesisInvocations[0]?.systemPrompt ?? "",
    },
  ]);
  assert.match(synthesisInvocations[0]?.systemPrompt ?? "", /Return valid JSON only/i);
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
      message: "pi-consensus participant pass and synthesis completed.",
    },
  ]);
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /anthropic\/claude-sonnet-4-5 — running/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /anthropic\/claude-sonnet-4-5 — completed/.test(line))),
  );
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — running/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — completed/.test(line))));
  assert.ok(commandContext.statusUpdates.some((status) => /validating/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /participant pass/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /synthesis/i.test(status)));
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool shows a clear error when config is missing", async () => {
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

  await assert.rejects(
    harness.registeredTool?.execute(
      "tool-call-missing-config",
      { prompt: "draft a migration plan" },
      undefined,
      undefined,
      commandContext,
    ),
    /Consensus config not found\. Create \.pi\/consensus\.json or ~\/\.pi\/agent\/consensus\.json with at least 2 participant models\./,
  );
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool returns a clear result when fewer than two usable participant outputs remain after filtering", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-filtered-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    }),
  );

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => {
      if (invocation.model.provider === "anthropic") {
        return {
          model: invocation.model,
          status: "completed",
          output:
            "Recommendation: update src/index.ts. Why: it centralizes dispatch. Risks/tradeoffs: medium migration cost. Confidence: 82%.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        };
      }

      if (invocation.model.provider === "openai") {
        return {
          model: invocation.model,
          status: "completed",
          output: "I'm sorry, but I can't help with that request.",
          inspectedRepo: false,
          toolNamesUsed: [],
        };
      }

      return {
        model: invocation.model,
        status: "failed",
        failureReason: "participant subprocess exited with code 1",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  });

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
    { provider: "google", id: "gemini-2.5-pro" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = mkdtempSync(join(tmpdir(), "pi-consensus-agent-filtered-"));

  const toolResult = await harness.registeredTool?.execute(
    "tool-call-filtered",
    { prompt: "draft a migration plan" },
    undefined,
    undefined,
    commandContext,
  );

  const content = toolResult?.content[0]?.text ?? "";
  assert.match(
    content,
    /Consensus requires at least 2 usable participant outputs but only 1 remained after filtering\./,
  );
  assert.match(content, /openai\/gpt-5 — excluded/);
  assert.match(content, /Reason: refusal-only response/);
  assert.match(content, /google\/gemini-2\.5-pro — failed/);
  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Synthesis model "openai/gpt-5" is also configured as a participant.',
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
      "tool-call-2",
      { prompt: "draft a migration plan" },
      undefined,
      undefined,
      {
        ...createCommandContext(projectDir),
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

test("consensus tool clears progress and reports synthesis failures cleanly", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-synthesis-error-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    }),
  );

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => ({
      model: invocation.model,
      status: "completed",
      output: "Recommendation: inspect src/index.ts. Why: central orchestration. Risks/tradeoffs: low. Confidence: 80%.",
      inspectedRepo: true,
      toolNamesUsed: ["read", "multi_grep"],
    }),
    executeSynthesisInvocation: async () => {
      throw new Error("synthesis subprocess exited with code 1");
    },
  });

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = mkdtempSync(join(tmpdir(), "pi-consensus-agent-synthesis-error-"));

  await assert.rejects(
    harness.registeredTool?.execute(
      "tool-call-synthesis-error",
      { prompt: "draft a migration plan" },
      undefined,
      undefined,
      commandContext,
    ),
    /synthesis subprocess exited with code 1/,
  );

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Synthesis model "openai/gpt-5" is also configured as a participant.',
    },
  ]);
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool fails clearly when participant count exceeds the safety cap", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-too-many-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-5",
        "google/gemini-2.5-pro",
        "xai/grok-4",
        "openrouter/anthropic-claude-3.7-sonnet",
        "openrouter/openai-gpt-4.1",
        "deepseek/deepseek-chat",
        "moonshot/kimi-k2",
        "mistral/mistral-large",
      ],
    }),
  );

  const harness = createExtensionHarness();
  consensusExtension(harness.pi as never);

  await assert.rejects(
    harness.registeredTool?.execute(
      "tool-call-too-many",
      { prompt: "draft a migration plan" },
      undefined,
      undefined,
      {
        ...createCommandContext(projectDir),
        agentDir: mkdtempSync(join(tmpdir(), "pi-consensus-agent-too-many-")),
        model: { provider: "openai", id: "gpt-5" },
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-5" },
            { provider: "openai", id: "gpt-5" },
            { provider: "google", id: "gemini-2.5-pro" },
            { provider: "xai", id: "grok-4" },
            { provider: "openrouter", id: "anthropic-claude-3.7-sonnet" },
            { provider: "openrouter", id: "openai-gpt-4.1" },
            { provider: "deepseek", id: "deepseek-chat" },
            { provider: "moonshot", id: "kimi-k2" },
            { provider: "mistral", id: "mistral-large" },
          ],
        },
      },
    ),
    /supports at most 8 unique participant models/,
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
  const sentMessages: Array<{
    message: { customType: string; content: string; details?: unknown; display: boolean };
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
  }> = [];
  const sentUserMessages: unknown[] = [];
  const sentToolLikeMessages: unknown[] = [];

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
    sendUserMessage: (message: unknown, options?: unknown) => {
      sentUserMessages.push({ message, options });
    },
    sendToolLikeMessage: (message: unknown, options?: unknown) => {
      sentToolLikeMessages.push({ message, options });
    },
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
    sentUserMessages,
    sentToolLikeMessages,
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
