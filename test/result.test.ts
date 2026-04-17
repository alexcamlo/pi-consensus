import assert from "node:assert/strict";
import test from "node:test";

import { createConsensusExecutionResult } from "../src/result.ts";

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

test("createConsensusExecutionResult includes raw synthesis output in details and markdown debug section", () => {
  const rawSynthesisOutputText = '{"consensusAnswer":"Use staged rollout","overallAgreementPercent":"70"}';

  const result = createConsensusExecutionResult(
    "plan migration",
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
        output: "Recommendation: staged rollout.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      },
      {
        model: "openai/gpt-5",
        status: "usable",
        output: "Recommendation: phased rollout.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      },
    ],
    undefined,
    {
      consensusAnswer: "Use staged rollout.",
      overallAgreementPercent: 70,
      overallDisagreementPercent: 20,
      overallUnclearPercent: 10,
      confidencePercent: 75,
      confidenceLabel: "medium",
      agreedPoints: [],
      disagreements: [],
      participants: [],
      excludedParticipants: [],
    },
    "repaired",
    rawSynthesisOutputText,
  );

  assert.equal(result.details.rawSynthesisOutputText, rawSynthesisOutputText);
  assert.match(result.text, /## Debug synthesis output/m);
  assert.match(result.text, /\{"consensusAnswer":"Use staged rollout","overallAgreementPercent":"70"\}/);
});

test("createConsensusExecutionResult surfaces warning-bearing usable participants in details and markdown", () => {
  const result = createConsensusExecutionResult(
    "evaluate rollout",
    {
      configPath: ".pi/consensus.json",
      participants: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      synthesisModel: "openai/gpt-5",
      warnings: [],
    },
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        status: "usable-with-warning",
        output: "Recommendation: proceed incrementally.",
        warningReasons: ["missing structured sections: why, risks/tradeoffs, confidence, repo evidence"],
        surfacedDiagnostics: [
          {
            code: "missing-structured-sections",
            message: "missing structured sections: why, risks/tradeoffs, confidence, repo evidence",
            severity: "warning",
          },
        ],
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      },
      {
        model: "openai/gpt-5",
        status: "usable",
        output: "Recommendation: proceed. Why: minimizes risk. Risks/tradeoffs: slower rollout. Confidence: high.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      },
    ],
  );

  assert.equal(result.details.usableParticipantCount, 2);
  assert.equal(result.details.excludedParticipantCount, 0);
  assert.equal(result.details.participants[0]?.status, "usable-with-warning");
  assert.deepEqual(result.details.participants[0]?.warningReasons, [
    "missing structured sections: why, risks/tradeoffs, confidence, repo evidence",
  ]);
  assert.match(result.text, /### anthropic\/claude-sonnet-4-5 — usable-with-warning/);
  assert.match(result.text, /Warnings: missing structured sections: why, risks\/tradeoffs, confidence, repo evidence/);
  assert.match(result.text, /Diagnostics: warning:missing-structured-sections \(missing structured sections: why, risks\/tradeoffs, confidence, repo evidence\)/);
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

  assert.match(result.text, /anthropic\/claude-sonnet-4-5 \(stance: for, focus: security\) — Recommended JWT/);
  assert.match(result.text, /openai\/gpt-5 \(stance: against\) — Suggested alternatives/);
  assert.match(result.text, /### anthropic\/claude-sonnet-4-5 — usable \(stance: for, focus: security\)/);
  assert.match(result.text, /### openai\/gpt-5 — usable \(stance: against\)/);
  assert.match(result.text, /### google\/gemini-2\.5-pro — excluded \(stance: neutral, focus: performance\)/);

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

  assert.match(result.text, /## Participants/);
  assert.match(result.text, /anthropic\/claude-sonnet-4-5 — usable/);
  assert.doesNotMatch(result.text, /## Participants[\s\S]*anthropic\/claude-sonnet-4-5.*stance:/);
  assert.doesNotMatch(result.text, /## Participants[\s\S]*openai\/gpt-5.*focus:/);
});
