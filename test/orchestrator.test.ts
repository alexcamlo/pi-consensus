import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConsensusOrchestrator, type ConsensusRunProgress } from "../src/orchestrator.ts";

test("ConsensusOrchestrator executes successful end-to-end run through its boundary", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-orchestrator-success-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    }),
  );

  const participantCalls: string[] = [];
  const synthesisCalls: string[] = [];
  const progressEvents: ConsensusRunProgress[] = [];
  const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];

  const orchestrator = createConsensusOrchestrator({
    executeParticipantInvocation: async (invocation) => {
      participantCalls.push(`${invocation.model.provider}/${invocation.model.id}`);
      return {
        model: invocation.model,
        status: "completed",
        output: "Recommendation: proceed. Why: clear path. Risks/tradeoffs: moderate migration effort. Confidence: high. Repo evidence: src/index.ts owns command wiring.",
        inspectedRepo: true,
        toolNamesUsed: ["read"],
      };
    },
    executeSynthesisInvocation: async (invocation) => {
      synthesisCalls.push(`${invocation.model.provider}/${invocation.model.id}`);
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

  const outcome = await orchestrator.execute(
    { prompt: "plan the migration" },
    {
      cwd: projectDir,
      currentModel: { provider: "openai", id: "gpt-5" },
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai", id: "gpt-5" },
      ],
    },
    {
      onProgress: (event) => {
        progressEvents.push(event);
      },
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  );

  assert.equal(outcome.details.status, "synthesis-complete");
  assert.equal(participantCalls.length, 2);
  assert.equal(synthesisCalls.length, 1);
  assert.ok(progressEvents.some((event) => event.stage === "config-validation"));
  assert.ok(progressEvents.some((event) => event.stage === "participant-pass"));
  assert.ok(progressEvents.some((event) => event.stage === "pre-synthesis-gate"));
  assert.ok(progressEvents.some((event) => event.stage === "synthesis"));
  assert.ok(notifications.some((entry) => entry.level === "warning" && entry.message.includes("Synthesis model \"openai/gpt-5\" is also configured as a participant.")));
  assert.ok(notifications.some((entry) => entry.level === "info" && entry.message === "pi-consensus participant pass and synthesis completed."));
});

test("ConsensusOrchestrator skips synthesis when usable participant minimum is not met", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-orchestrator-gate-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    }),
  );

  let synthesisCalled = false;
  let participantCallCount = 0;
  const progressEvents: ConsensusRunProgress[] = [];

  const orchestrator = createConsensusOrchestrator({
    executeParticipantInvocation: async (invocation) => {
      participantCallCount += 1;
      if (invocation.model.provider === "anthropic") {
        return {
          model: invocation.model,
          status: "completed",
          output: "Maybe.",
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
    executeSynthesisInvocation: async () => {
      synthesisCalled = true;
      throw new Error("synthesis should not run");
    },
  });

  const outcome = await orchestrator.execute(
    { prompt: "plan the migration" },
    {
      cwd: projectDir,
      currentModel: { provider: "openai", id: "gpt-5" },
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai", id: "gpt-5" },
      ],
    },
    {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    },
  );

  assert.equal(participantCallCount, 2);
  assert.equal(synthesisCalled, false);
  assert.equal(outcome.details.status, "participant-pass-insufficient-usable");
  assert.match(outcome.details.failureMessage ?? "", /requires at least 2 usable participant outputs/);
  assert.ok(progressEvents.some((event) => event.stage === "pre-synthesis-gate"));
  assert.ok(progressEvents.some((event) => event.synthesis === "skipped"));
});
