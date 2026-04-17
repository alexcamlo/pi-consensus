import assert from "node:assert/strict";
import test from "node:test";

import {
  createSynthesisRepairPrompt,
  createSynthesisSystemPrompt,
  normalizeSynthesisOutput,
  runConsensusSynthesis,
  runSynthesisInvocation,
  readSynthesisEventLine,
  type SynthesisInvocationResult,
} from "../src/synthesis.ts";

const config = {
  configPath: ".pi/consensus.json",
  configSource: "project" as const,
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ],
  synthesisModel: { provider: "openai", id: "gpt-5" },
  synthesisMaxRetries: 1,
  warnings: [],
};

test("runConsensusSynthesis uses the configured synthesis model and passes full usable participant outputs", async () => {
  const invocations: Array<{ model: string; cwd: string; prompt: string; allowedTools: string[]; systemPrompt: string }> = [];

  const result = await runConsensusSynthesis(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config,
      usableParticipants: [
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          status: "usable",
          output: "Recommendation: roll out incrementally.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        },
        {
          model: { provider: "openai", id: "gpt-5" },
          status: "usable",
          output: "Recommendation: use a staged migration.",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
      excludedParticipants: [
        {
          model: { provider: "google", id: "gemini-2.5-pro" },
          status: "excluded",
          output: "Maybe refactor it.",
          exclusionReason: "response was too vague to use for consensus",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
    },
    async (invocation): Promise<SynthesisInvocationResult> => {
      invocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        allowedTools: invocation.allowedTools,
        systemPrompt: invocation.systemPrompt,
      });

      return {
        model: invocation.model,
        output: {
          consensusAnswer: "Use an incremental migration.",
          overallAgreementPercent: 65,
          overallDisagreementPercent: 25,
          overallUnclearPercent: 10,
          confidencePercent: 76,
          confidenceLabel: "medium",
          agreedPoints: [
            {
              point: "Prefer a staged rollout.",
              supportPercent: 100,
              supportingParticipants: 2,
              totalParticipants: 2,
            },
          ],
          disagreements: [
            {
              point: "How much automation to add up front.",
              summary: "The models differ on whether to automate cleanup immediately.",
            },
          ],
          participants: [
            {
              model: "anthropic/claude-sonnet-4-5",
              summary: "Preferred an incremental rollout.",
            },
            {
              model: "openai/gpt-5",
              summary: "Preferred a staged migration.",
            },
          ],
          excludedParticipants: [
            {
              model: "google/gemini-2.5-pro",
              reason: "response was too vague to use for consensus",
            },
          ],
        },
      };
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.model.provider, "openai");
  assert.equal(result.output.consensusAnswer, "Use an incremental migration.");
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], {
    model: "openai/gpt-5",
    cwd: "/tmp/project",
    prompt:
      'Original user prompt:\n"""\ndraft a migration plan\n"""\n\nUsable participant outputs:\n\nParticipant: anthropic/claude-sonnet-4-5\nRecommendation: roll out incrementally.\n\nParticipant: openai/gpt-5\nRecommendation: use a staged migration.',
    allowedTools: [],
    systemPrompt: invocations[0]?.systemPrompt ?? "",
  });
  assert.match(invocations[0]?.systemPrompt ?? "", /agreement, disagreement, and unclear percentages that sum to 100/i);
});

test("createSynthesisSystemPrompt explicitly constrains numeric JSON fields", () => {
  const systemPrompt = createSynthesisSystemPrompt([
    {
      model: { provider: "google", id: "gemini-2.5-pro" },
      status: "excluded",
      output: "Maybe refactor it.",
      exclusionReason: "response was too vague to use for consensus",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
  ]);

  assert.match(systemPrompt, /Return valid JSON only with no markdown fences or commentary\./i);
  assert.match(systemPrompt, /All percentage and count fields must be JSON numbers, never strings\./i);
  assert.match(systemPrompt, /supportingParticipants and totalParticipants must be non-negative JSON integers, never fractions like "2\/3"\./i);
  assert.match(systemPrompt, /Do not use null, omit required numeric fields, or encode numbers as quoted strings\./i);
  assert.match(systemPrompt, /"supportPercent":100,"supportingParticipants":2,"totalParticipants":2/i);
});

test("runConsensusSynthesis retries once with a repair prompt when validation fails and returns the repaired output", async () => {
  const invocations: Array<{ prompt: string; systemPrompt: string }> = [];

  const result = await runConsensusSynthesis(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config,
      usableParticipants: [
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          status: "usable",
          output: "Recommendation: roll out incrementally.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        },
        {
          model: { provider: "openai", id: "gpt-5" },
          status: "usable",
          output: "Recommendation: use a staged migration.",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
      excludedParticipants: [],
    },
    async (invocation): Promise<SynthesisInvocationResult> => {
      invocations.push({ prompt: invocation.prompt, systemPrompt: invocation.systemPrompt });

      if (invocations.length === 1) {
        // Use negative number (can't be normalized) to trigger repair
        return {
          model: invocation.model,
          rawOutputText:
            '{"consensusAnswer":"Use an incremental migration.","overallAgreementPercent":65,"overallDisagreementPercent":25,"overallUnclearPercent":10,"confidencePercent":76,"confidenceLabel":"medium","agreedPoints":[{"point":"Prefer a staged rollout.","supportPercent":100,"supportingParticipants":-1,"totalParticipants":2}],"disagreements":[],"participants":[],"excludedParticipants":[]}',
          output: {
            consensusAnswer: "Use an incremental migration.",
            overallAgreementPercent: 65,
            overallDisagreementPercent: 25,
            overallUnclearPercent: 10,
            confidencePercent: 76,
            confidenceLabel: "medium",
            agreedPoints: [
              {
                point: "Prefer a staged rollout.",
                supportPercent: 100,
                supportingParticipants: -1,
                totalParticipants: 2,
              },
            ],
            disagreements: [],
            participants: [],
            excludedParticipants: [],
          },
        };
      }

      // Repair returns valid output
      return {
        model: invocation.model,
        rawOutputText:
          '{"consensusAnswer":"Use an incremental migration.","overallAgreementPercent":65,"overallDisagreementPercent":25,"overallUnclearPercent":10,"confidencePercent":76,"confidenceLabel":"medium","agreedPoints":[{"point":"Prefer a staged rollout.","supportPercent":100,"supportingParticipants":2,"totalParticipants":2}],"disagreements":[],"participants":[],"excludedParticipants":[]}',
        output: {
          consensusAnswer: "Use an incremental migration.",
          overallAgreementPercent: 65,
          overallDisagreementPercent: 25,
          overallUnclearPercent: 10,
          confidencePercent: 76,
          confidenceLabel: "medium",
          agreedPoints: [
            {
              point: "Prefer a staged rollout.",
              supportPercent: 100,
              supportingParticipants: 2,
              totalParticipants: 2,
            },
          ],
          disagreements: [],
          participants: [],
          excludedParticipants: [],
        },
      };
    },
  );

  assert.equal(result.output.agreedPoints[0]?.supportingParticipants, 2);
  assert.equal(result.status, "complete");
  assert.equal(invocations.length, 2);
  assert.match(invocations[1]?.prompt ?? "", /Validation error:\nConsensus synthesis output field "agreedPoints\[\]\.supportingParticipants" must be a non-negative integer\./);
  assert.match(invocations[1]?.prompt ?? "", /Original invalid JSON:/);
  assert.match(invocations[1]?.prompt ?? "", /"supportingParticipants":-1/);
  assert.match(invocations[1]?.systemPrompt ?? "", /repairing previously generated JSON/i);
});

test("createSynthesisRepairPrompt includes the original invalid JSON and exact validation error", () => {
  const prompt = createSynthesisRepairPrompt('{"supportingParticipants":"2"}', 'Consensus synthesis output field "agreedPoints[].supportingParticipants" must be a non-negative integer.');

  assert.match(prompt, /Validation error:\nConsensus synthesis output field "agreedPoints\[\]\.supportingParticipants" must be a non-negative integer\./);
  assert.match(prompt, /Original invalid JSON:\n\{"supportingParticipants":"2"\}/);
  assert.match(prompt, /Return corrected JSON only/i);
});

test("runConsensusSynthesis returns degraded result when repair also fails", async () => {
  const invocations: Array<{ prompt: string; systemPrompt: string }> = [];
  const rawText = "Based on participant outputs, an incremental migration approach is recommended.";

  const result = await runConsensusSynthesis(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config,
      usableParticipants: [
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          status: "usable",
          output: "Recommendation: roll out incrementally.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        },
        {
          model: { provider: "openai", id: "gpt-5" },
          status: "usable",
          output: "Recommendation: use a staged migration.",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
      excludedParticipants: [],
    },
    async (invocation): Promise<SynthesisInvocationResult> => {
      invocations.push({ prompt: invocation.prompt, systemPrompt: invocation.systemPrompt });

      return {
        model: invocation.model,
        rawOutputText: rawText,
        output: {
          consensusAnswer: "Use an incremental migration.",
          overallAgreementPercent: 60,
          overallDisagreementPercent: 25,
          overallUnclearPercent: 10,
          confidencePercent: 76,
          confidenceLabel: "medium",
          agreedPoints: [],
          disagreements: [],
          participants: [],
          excludedParticipants: [],
        },
      };
    },
  );

  // After repair fails, should return degraded result with raw text preserved
  assert.equal(result.status, "degraded");
  assert.equal(result.degradedText, rawText);
  assert.ok(result.rawOutputText);
  assert.equal(invocations.length, 2); // Initial + repair attempt
});

test("normalizeSynthesisOutput extracts JSON from markdown code blocks", () => {
  const rawOutput = `Here's the consensus result:

\`\`\`json
{
  "consensusAnswer": "Use an incremental migration.",
  "overallAgreementPercent": 65,
  "overallDisagreementPercent": 25,
  "overallUnclearPercent": 10,
  "confidencePercent": 76,
  "confidenceLabel": "medium",
  "agreedPoints": [{"point":"test","supportPercent":100,"supportingParticipants":2,"totalParticipants":2}],
  "disagreements": [],
  "participants": [{"model":"test","summary":"test"}],
  "excludedParticipants": []
}
\`\`\``;

  const normalized = normalizeSynthesisOutput(rawOutput);
  assert.equal(normalized.status, "extracted");
  assert.equal(normalized.output?.consensusAnswer, "Use an incremental migration.");
  assert.equal(normalized.output?.overallAgreementPercent, 65);
});

test("normalizeSynthesisOutput coerces numeric strings to numbers", () => {
  const rawOutput = JSON.stringify({
    consensusAnswer: "Test",
    overallAgreementPercent: "65",
    overallDisagreementPercent: "25",
    overallUnclearPercent: "10",
    confidencePercent: "76",
    confidenceLabel: "medium",
    agreedPoints: [{ point: "test", supportPercent: "100", supportingParticipants: "2", totalParticipants: 2 }],
    disagreements: [],
    participants: [],
    excludedParticipants: [],
  });

  const normalized = normalizeSynthesisOutput(rawOutput);
  assert.equal(normalized.status, "normalized");
  assert.equal(typeof normalized.output?.overallAgreementPercent, "number");
  assert.equal(normalized.output?.overallAgreementPercent, 65);
  assert.equal(typeof normalized.output?.agreedPoints[0]?.supportPercent, "number");
  assert.equal(normalized.output?.agreedPoints[0]?.supportPercent, 100);
});

test("normalizeSynthesisOutput normalizes missing optional arrays to empty arrays", () => {
  const rawOutput = JSON.stringify({
    consensusAnswer: "Test",
    overallAgreementPercent: 65,
    overallDisagreementPercent: 25,
    overallUnclearPercent: 10,
    confidencePercent: 76,
    confidenceLabel: "medium",
    agreedPoints: [],
    // disagreements omitted
    participants: [],
    // excludedParticipants omitted
  });

  const normalized = normalizeSynthesisOutput(rawOutput);
  assert.equal(normalized.status, "normalized");
  assert.deepEqual(normalized.output?.disagreements, []);
  assert.deepEqual(normalized.output?.excludedParticipants, []);
});

test("normalizeSynthesisOutput normalizes slight percentage drift", () => {
  // Sums to 99 instead of 100 (rounding drift)
  const rawOutput = JSON.stringify({
    consensusAnswer: "Test",
    overallAgreementPercent: 65.3,
    overallDisagreementPercent: 24.8,
    overallUnclearPercent: 8.9, // Sum = 99
    confidencePercent: 76,
    confidenceLabel: "medium",
    agreedPoints: [],
    disagreements: [],
    participants: [],
    excludedParticipants: [],
  });

  const normalized = normalizeSynthesisOutput(rawOutput);
  assert.equal(normalized.status, "normalized");
  const sum = (normalized.output?.overallAgreementPercent ?? 0) + 
              (normalized.output?.overallDisagreementPercent ?? 0) + 
              (normalized.output?.overallUnclearPercent ?? 0);
  assert.equal(sum, 100);
});

test("normalizeSynthesisOutput rejects unrecoverable malformed JSON", () => {
  const rawOutput = "This is just plain text without any JSON structure.";

  const normalized = normalizeSynthesisOutput(rawOutput);
  assert.equal(normalized.status, "unrecoverable");
  assert.equal(normalized.output, undefined);
});

test("degraded synthesis result preserves raw text and indicates degraded status", async () => {
  const rawText = "Based on participant outputs, an incremental migration is recommended.";
  
  const result = await runConsensusSynthesis(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config,
      usableParticipants: [
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          status: "usable",
          output: "Recommendation: roll out incrementally.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        },
        {
          model: { provider: "openai", id: "gpt-5" },
          status: "usable",
          output: "Recommendation: use a staged migration.",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
      excludedParticipants: [],
    },
    async (invocation): Promise<SynthesisInvocationResult> => ({
      model: invocation.model,
      rawOutputText: rawText,
      output: {
        consensusAnswer: "Invalid", // This won't pass validation
        overallAgreementPercent: 60,
        overallDisagreementPercent: 25,
        overallUnclearPercent: 10, // Sum != 100
        confidencePercent: 76,
        confidenceLabel: "medium",
        agreedPoints: [],
        disagreements: [],
        participants: [],
        excludedParticipants: [],
      },
    }),
  );

  assert.equal(result.status, "degraded");
  assert.equal(result.degradedText, rawText);
  assert.ok(result.rawOutputText);
  assert.equal(result.output?.confidenceLabel, "low (degraded mode - synthesis output was malformed)");
  assert.ok(result.output?.consensusAnswer.includes("incremental migration") || result.output?.consensusAnswer === rawText);
});

test("runConsensusSynthesis retries transient synthesis failures once before degrading", async () => {
  let attemptCount = 0;
  const configWithRetry = { ...config, synthesisMaxRetries: 1 };

  const result = await runConsensusSynthesis(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config: configWithRetry,
      usableParticipants: [
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          status: "usable",
          output: "Recommendation: roll out incrementally.",
          inspectedRepo: true,
          toolNamesUsed: ["read"],
        },
        {
          model: { provider: "openai", id: "gpt-5" },
          status: "usable",
          output: "Recommendation: use a staged migration.",
          inspectedRepo: false,
          toolNamesUsed: [],
        },
      ],
      excludedParticipants: [],
    },
    async (invocation): Promise<SynthesisInvocationResult> => {
      attemptCount++;
      // First attempt fails with transient error, retry succeeds
      if (attemptCount === 1) {
        throw new Error("synthesis subprocess timed out after 30000ms");
      }
      return {
        model: invocation.model,
        output: {
          consensusAnswer: "Use an incremental migration.",
          overallAgreementPercent: 65,
          overallDisagreementPercent: 25,
          overallUnclearPercent: 10,
          confidencePercent: 76,
          confidenceLabel: "medium",
          agreedPoints: [],
          disagreements: [],
          participants: [],
          excludedParticipants: [],
        },
      };
    },
  );

  assert.equal(attemptCount, 2); // Initial + 1 retry
  assert.equal(result.output.consensusAnswer, "Use an incremental migration.");
});

test("readSynthesisEventLine captures assistant message_end text and ignores non-JSON/non-assistant events", () => {
  assert.equal(readSynthesisEventLine("plain text line"), undefined);

  assert.equal(
    readSynthesisEventLine('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"},{"type":"text","text":" second"}]}}'),
    "first second",
  );

  assert.equal(
    readSynthesisEventLine('{"type":"tool_execution_start","toolName":"read"}'),
    undefined,
  );

  assert.equal(
    readSynthesisEventLine('{"type":"message_end","message":{"role":"user","content":"not assistant"}}'),
    undefined,
  );
});

test("runSynthesisInvocation maps shared runner output into parsed synthesis JSON", async () => {
  const result = await runSynthesisInvocation(
    {
      model: { provider: "openai", id: "gpt-5" },
      cwd: "/tmp/project",
      prompt: "prompt",
      systemPrompt: "system",
      allowedTools: [],
    },
    async (request) => {
      assert.match(request.args.join(" "), /--mode json/);
      return {
        assistantText: JSON.stringify({
          consensusAnswer: "Use incremental migration.",
          overallAgreementPercent: 70,
          overallDisagreementPercent: 20,
          overallUnclearPercent: 10,
          confidencePercent: 80,
          confidenceLabel: "high",
          agreedPoints: [],
          disagreements: [],
          participants: [],
          excludedParticipants: [],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
      };
    },
  );

  assert.equal(result.output.consensusAnswer, "Use incremental migration.");
  assert.equal(result.rawOutputText?.includes("consensusAnswer"), true);
});

test("runConsensusSynthesis does not retry non-transient synthesis failures", async () => {
  let attemptCount = 0;
  const configWithRetry = { ...config, synthesisMaxRetries: 1 };

  await assert.rejects(
    runConsensusSynthesis(
      {
        prompt: "draft a migration plan",
        cwd: "/tmp/project",
        config: configWithRetry,
        usableParticipants: [
          {
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            status: "usable",
            output: "Recommendation: roll out incrementally.",
            inspectedRepo: true,
            toolNamesUsed: ["read"],
          },
        ],
        excludedParticipants: [],
      },
      async (): Promise<SynthesisInvocationResult> => {
        attemptCount++;
        throw new Error("synthesis subprocess exited with code 1");
      },
    ),
    /synthesis subprocess exited with code 1/,
  );

  assert.equal(attemptCount, 1); // No retry for non-transient errors
});
