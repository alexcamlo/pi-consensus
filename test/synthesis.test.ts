import assert from "node:assert/strict";
import test from "node:test";

import {
  createSynthesisRepairPrompt,
  createSynthesisSystemPrompt,
  runConsensusSynthesis,
  type SynthesisExecutionResult,
} from "../src/synthesis.ts";

const config = {
  configPath: ".pi/consensus.json",
  configSource: "project" as const,
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
  ],
  synthesisModel: { provider: "openai", id: "gpt-5" },
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
    async (invocation): Promise<SynthesisExecutionResult> => {
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
    async (invocation): Promise<SynthesisExecutionResult> => {
      invocations.push({ prompt: invocation.prompt, systemPrompt: invocation.systemPrompt });

      if (invocations.length === 1) {
        return {
          model: invocation.model,
          rawOutputText:
            '{"consensusAnswer":"Use an incremental migration.","overallAgreementPercent":65,"overallDisagreementPercent":25,"overallUnclearPercent":10,"confidencePercent":76,"confidenceLabel":"medium","agreedPoints":[{"point":"Prefer a staged rollout.","supportPercent":100,"supportingParticipants":"2","totalParticipants":2}],"disagreements":[],"participants":[],"excludedParticipants":[]}',
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
                supportingParticipants: "2" as unknown as number,
                totalParticipants: 2,
              },
            ],
            disagreements: [],
            participants: [],
            excludedParticipants: [],
          },
        };
      }

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
  assert.equal(invocations.length, 2);
  assert.match(invocations[1]?.prompt ?? "", /Validation error:\nConsensus synthesis output field "agreedPoints\[\]\.supportingParticipants" must be a non-negative integer\./);
  assert.match(invocations[1]?.prompt ?? "", /Original invalid JSON:/);
  assert.match(invocations[1]?.prompt ?? "", /"supportingParticipants":"2"/);
  assert.match(invocations[1]?.systemPrompt ?? "", /repairing previously generated JSON/i);
});

test("createSynthesisRepairPrompt includes the original invalid JSON and exact validation error", () => {
  const prompt = createSynthesisRepairPrompt('{"supportingParticipants":"2"}', 'Consensus synthesis output field "agreedPoints[].supportingParticipants" must be a non-negative integer.');

  assert.match(prompt, /Validation error:\nConsensus synthesis output field "agreedPoints\[\]\.supportingParticipants" must be a non-negative integer\./);
  assert.match(prompt, /Original invalid JSON:\n\{"supportingParticipants":"2"\}/);
  assert.match(prompt, /Return corrected JSON only/i);
});

test("runConsensusSynthesis fails clearly when synthesis repair also fails", async () => {
  await assert.rejects(
    runConsensusSynthesis(
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
      async (invocation): Promise<SynthesisExecutionResult> => ({
        model: invocation.model,
        rawOutputText: '{"consensusAnswer":"Use an incremental migration.","overallAgreementPercent":60,"overallDisagreementPercent":25,"overallUnclearPercent":10,"confidencePercent":76,"confidenceLabel":"medium","agreedPoints":[],"disagreements":[],"participants":[],"excludedParticipants":[]}',
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
      }),
    ),
    /Synthesis repair also failed: Consensus synthesis output overallAgreementPercent, overallDisagreementPercent, and overallUnclearPercent must sum to 100\./,
  );
});
