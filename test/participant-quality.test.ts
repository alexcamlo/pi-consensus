import assert from "node:assert/strict";
import test from "node:test";

import { classifyParticipantQuality } from "../src/participant-quality.ts";

test("classifyParticipantQuality returns usable classification without surfaced diagnostics for complete structured output", () => {
  const classified = classifyParticipantQuality({
    model: { provider: "openai", id: "gpt-5" },
    status: "completed",
    output:
      "Recommendation: proceed. Why: clear path. Risks/tradeoffs: manageable. Confidence: high. Repo evidence: src/orchestrator.ts",
    inspectedRepo: true,
    toolNamesUsed: ["read"],
  });

  assert.equal(classified.status, "usable");
  assert.equal(classified.surfacedDiagnostics.length, 0);
});

test("classifyParticipantQuality returns excluded classification with surfaced diagnostic reasons", () => {
  const classified = classifyParticipantQuality({
    model: { provider: "openai", id: "gpt-5" },
    status: "completed",
    output: "I'm sorry, but I can't help with that request.",
    inspectedRepo: false,
    toolNamesUsed: [],
  });

  assert.equal(classified.status, "excluded");
  assert.equal(classified.exclusionReason, "refusal-only response");
  assert.deepEqual(classified.surfacedDiagnostics, [
    {
      code: "refusal-only-response",
      message: "refusal-only response",
      severity: "error",
    },
  ]);
});

test("classifyParticipantQuality returns failed classification with surfaced subprocess diagnostic", () => {
  const classified = classifyParticipantQuality({
    model: { provider: "openai", id: "gpt-5" },
    status: "failed",
    failureReason: "participant subprocess exited with code 1",
    inspectedRepo: false,
    toolNamesUsed: [],
  });

  assert.equal(classified.status, "failed");
  assert.equal(classified.failureReason, "participant subprocess exited with code 1");
  assert.deepEqual(classified.surfacedDiagnostics, [
    {
      code: "participant-execution-failed",
      message: "participant subprocess exited with code 1",
      severity: "error",
    },
  ]);
});
