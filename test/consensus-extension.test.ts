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
        allowedTools: ["read", "ls", "find", "grep"],
      },
      {
        model: "openai/gpt-5",
        cwd: projectDir,
        prompt: "draft a migration plan",
        allowedTools: ["read", "ls", "find", "grep"],
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
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage — config validation/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /Selected participants — anthropic\/claude-sonnet-4-5, openai\/gpt-5/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /Selected synthesis model — openai\/gpt-5/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /Counts — usable: 0, failed: 0, excluded: 0, remaining: 2/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /anthropic\/claude-sonnet-4-5 — running/.test(line))),
  );
  assert.ok(
    commandContext.widgetUpdates.some((lines) => lines.some((line) => /anthropic\/claude-sonnet-4-5 — completed/.test(line))),
  );
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage — pre-synthesis gate/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — running/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — response received/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — validating/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — completed/.test(line))));
  assert.ok(commandContext.statusUpdates.some((status) => /validating consensus config/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /participant pass/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /pre-synthesis gate/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /synthesis response received/i.test(status)));
  assert.ok(commandContext.statusUpdates.some((status) => /validating synthesis output/i.test(status)));
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
    /Config validation failed: Consensus config not found\. Create \.pi\/consensus\.json or ~\/\.pi\/agent\/consensus\.json with at least 2 participant models\./,
  );
  assert.deepEqual(commandContext.notifications, [
    {
      level: "error",
      message:
        "Config validation failed: Consensus config not found. Create .pi/consensus.json or ~/.pi/agent/consensus.json with at least 2 participant models.",
    },
  ]);
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage — failed/.test(line))));
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool stops early, skips synthesis, and explains why when the minimum usable participant count becomes impossible", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-filtered-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    }),
  );

  const harness = createExtensionHarness();
  const participantOutcomes: string[] = [];
  let synthesisCalled = false;
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => {
      const model = `${invocation.model.provider}/${invocation.model.id}`;
      if (invocation.model.provider === "anthropic") {
        participantOutcomes.push(`${model}:completed`);
        return {
          model: invocation.model,
          status: "completed",
          output: "Maybe refactor it.",
          inspectedRepo: false,
          toolNamesUsed: [],
        };
      }

      if (invocation.model.provider === "openai") {
        participantOutcomes.push(`${model}:completed`);
        return {
          model: invocation.model,
          status: "completed",
          output: "I'm sorry, but I can't help with that request.",
          inspectedRepo: false,
          toolNamesUsed: [],
        };
      }

      await new Promise<void>((resolve) => {
        invocation.abortSignal?.addEventListener("abort", () => {
          participantOutcomes.push(`${model}:aborted`);
          resolve();
        }, { once: true });
      });

      return {
        model: invocation.model,
        status: "failed",
        failureReason: String(invocation.abortSignal?.reason ?? "aborted"),
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
    executeSynthesisInvocation: async () => {
      synthesisCalled = true;
      throw new Error("synthesis should have been skipped");
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
  assert.equal(synthesisCalled, false);
  assert.deepEqual(participantOutcomes, [
    "anthropic/claude-sonnet-4-5:completed",
    "openai/gpt-5:completed",
    "google/gemini-2.5-pro:aborted",
  ]);
  assert.match(content, /Consensus stopped early because only 0 usable participant outputs remained and 1 participant run was still in flight/);
  assert.match(content, /Consensus requires at least 2 usable participant outputs but only 0 remained after filtering\./);
  assert.match(content, /openai\/gpt-5 — excluded/);
  assert.match(content, /Reason: refusal-only response/);
  assert.match(content, /google\/gemini-2\.5-pro — failed/);
  assert.match(content, /reaching the minimum 2 usable participants became impossible/);
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — skipped/.test(line))));
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
    /Synthesis subprocess failed: synthesis subprocess exited with code 1/,
  );

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Synthesis model "openai/gpt-5" is also configured as a participant.',
    },
    {
      level: "error",
      message: "Synthesis subprocess failed: synthesis subprocess exited with code 1",
    },
  ]);
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage — failed/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — failed/.test(line))));
  assert.equal(commandContext.widgetCleared, true);
});

test("consensus tool reports synthesis output validation failures clearly when synthesis repair also fails", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-synthesis-validation-error-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    }),
  );

  const harness = createExtensionHarness();
  let synthesisCalls = 0;
  consensusExtension(harness.pi as never, {
    executeParticipantInvocation: async (invocation) => ({
      model: invocation.model,
      status: "completed",
      output: "Recommendation: inspect src/index.ts. Why: central orchestration. Risks/tradeoffs: low. Confidence: 80%.",
      inspectedRepo: true,
      toolNamesUsed: ["read"],
    }),
    executeSynthesisInvocation: async (invocation) => {
      synthesisCalls += 1;
      return {
        model: invocation.model,
        rawOutputText:
          synthesisCalls === 1
            ? '{"consensusAnswer":"Use the incremental migration plan.","overallAgreementPercent":70,"overallDisagreementPercent":20,"overallUnclearPercent":10,"confidencePercent":80,"confidenceLabel":"medium","agreedPoints":[{"point":"Roll out incrementally.","supportPercent":100,"supportingParticipants":-1,"totalParticipants":2}],"disagreements":[],"participants":[{"model":"anthropic/claude-sonnet-4-5","summary":"Recommended an incremental rollout."},{"model":"openai/gpt-5","summary":"Also recommended an incremental rollout."}],"excludedParticipants":[]}'
            : '{"consensusAnswer":"Use the incremental migration plan.","overallAgreementPercent":70,"overallDisagreementPercent":20,"overallUnclearPercent":10,"confidencePercent":80,"confidenceLabel":"medium","agreedPoints":[{"point":"Roll out incrementally.","supportPercent":100,"supportingParticipants":"two","totalParticipants":2}],"disagreements":[],"participants":[{"model":"anthropic/claude-sonnet-4-5","summary":"Recommended an incremental rollout."},{"model":"openai/gpt-5","summary":"Also recommended an incremental rollout."}],"excludedParticipants":[]}',
        output: {
          consensusAnswer: "Use the incremental migration plan.",
          overallAgreementPercent: 70,
          overallDisagreementPercent: 20,
          overallUnclearPercent: 10,
          confidencePercent: 80,
          confidenceLabel: "medium",
          agreedPoints: [
            {
              point: "Roll out incrementally.",
              supportPercent: 100,
              supportingParticipants: (synthesisCalls === 1 ? -1 : "two") as unknown as number,
              totalParticipants: 2,
            },
          ],
          disagreements: [],
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
      } as SynthesisExecutionResult;
    },
  });

  const commandContext = createCommandContext(projectDir, [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  commandContext.model = { provider: "openai", id: "gpt-5" };
  commandContext.agentDir = mkdtempSync(join(tmpdir(), "pi-consensus-agent-synthesis-validation-error-"));

  const result = await harness.registeredTool?.execute(
    "tool-call-synthesis-validation-error",
    { prompt: "draft a migration plan" },
    undefined,
    undefined,
    commandContext,
  );

  // Should return degraded result instead of failing
  assert.ok(result);
  assert.equal(result?.details.synthesis?.confidenceLabel, "low (degraded mode - synthesis output was malformed)");
  assert.equal(result?.details.status, "synthesis-complete");

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: 'Synthesis model "openai/gpt-5" is also configured as a participant.',
    },
    {
      level: "info",
      message: "pi-consensus participant pass and synthesis completed.",
    },
  ]);
  assert.ok(commandContext.statusUpdates.some((status) => /Validating synthesis output/i.test(status)));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Stage — synthesis/.test(line))));
  assert.ok(commandContext.widgetUpdates.some((lines) => lines.some((line) => /Synthesis — completed/.test(line))));
  assert.equal(synthesisCalls, 2);
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

test("createConsensusExecutionResult renders participant stance and focus in output", () => {
  const result = createConsensusExecutionResult(
    "evaluate authentication approach",
    {
      configPath: ".pi/consensus.json",
      participants: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
      synthesisModel: "openai/gpt-5",
      warnings: [],
    },
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        status: "usable",
        output: "Use JWT tokens.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
        stance: "for",
        focus: "security",
      },
      {
        model: "openai/gpt-5",
        status: "usable",
        output: "Consider session cookies.",
        inspectedRepo: false,
        toolNamesUsed: [],
        stance: "against",
      },
      {
        model: "google/gemini-2.5-pro",
        status: "excluded",
        output: "",
        exclusionReason: "empty response",
        inspectedRepo: false,
        toolNamesUsed: [],
        stance: "neutral",
        focus: "performance",
      },
    ],
    undefined,
    {
      consensusAnswer: "Use JWT with proper expiration.",
      overallAgreementPercent: 60,
      overallDisagreementPercent: 20,
      overallUnclearPercent: 20,
      confidencePercent: 75,
      confidenceLabel: "medium",
      agreedPoints: [{ point: "Use secure tokens", supportPercent: 100, supportingParticipants: 2, totalParticipants: 2 }],
      disagreements: [{ point: "Implementation details", summary: "Differ on cookie vs JWT" }],
      participants: [
        { model: "anthropic/claude-sonnet-4-5", summary: "Recommended JWT" },
        { model: "openai/gpt-5", summary: "Suggested alternatives" },
      ],
      excludedParticipants: [{ model: "google/gemini-2.5-pro", reason: "empty response" }],
    },
    "full",
  );

  // Verify stance and focus appear in Participants section
  assert.match(result.text, /## Participants/);
  assert.match(result.text, /anthropic\/claude-sonnet-4-5 \(stance: for, focus: security\) — Recommended JWT/);
  assert.match(result.text, /openai\/gpt-5 \(stance: against\) — Suggested alternatives/);

  // Verify excluded participant with stance/focus shown
  assert.match(result.text, /## Excluded/);
  assert.match(result.text, /google\/gemini-2\.5-pro — empty response/);

  // Verify debug section shows stance/focus
  assert.match(result.text, /## Debug participant outputs/);
  assert.match(result.text, /### anthropic\/claude-sonnet-4-5 — usable \(stance: for, focus: security\)/);
  assert.match(result.text, /### openai\/gpt-5 — usable \(stance: against\)/);
  assert.match(result.text, /### google\/gemini-2\.5-pro — excluded \(stance: neutral, focus: performance\)/);

  // Verify details include stance/focus
  assert.equal(result.details.participants[0].stance, "for");
  assert.equal(result.details.participants[0].focus, "security");
  assert.equal(result.details.participants[1].stance, "against");
  assert.equal(result.details.participants[1].focus, undefined);
  assert.equal(result.details.participants[2].stance, "neutral");
  assert.equal(result.details.participants[2].focus, "performance");
});

test("createConsensusExecutionResult handles participants without stance or focus", () => {
  const result = createConsensusExecutionResult(
    "simple query",
    {
      configPath: ".pi/consensus.json",
      participants: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      synthesisModel: "openai/gpt-5",
      warnings: [],
    },
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        status: "usable",
        output: "Answer",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
      {
        model: "openai/gpt-5",
        status: "usable",
        output: "Answer",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
    ],
  );

  // Verify no stance/focus framing when not provided
  assert.match(result.text, /## Participants/);
  assert.match(result.text, /anthropic\/claude-sonnet-4-5 — usable/);
  assert.doesNotMatch(result.text, /## Participants[\s\S]*anthropic\/claude-sonnet-4-5.*stance:/);
  assert.doesNotMatch(result.text, /## Participants[\s\S]*openai\/gpt-5.*focus:/);
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
