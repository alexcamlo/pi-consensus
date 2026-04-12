import assert from "node:assert/strict";
import test from "node:test";

import { runConsensusSynthesis, type SynthesisExecutionResult } from "../src/synthesis.ts";

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

test("runConsensusSynthesis rejects invalid structured output when percentages do not sum to 100", async () => {
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
    /must sum to 100/,
  );
});
