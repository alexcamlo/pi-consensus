import assert from "node:assert/strict";
import test from "node:test";

import {
  createParticipantSystemPrompt,
  EARLY_STOP_FAILURE_REASON,
  filterParticipantOutputs,
  runParticipantPass,
} from "../src/participants.ts";

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

test("runParticipantPass executes participant invocations in parallel with subprocess-safe read-only settings", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const invocations: Array<{
    model: string;
    prompt: string;
    cwd: string;
    allowedTools: string[];
    systemPrompt: string;
  }> = [];

  const result = await runParticipantPass(
    {
      prompt: "review the current repo structure",
      cwd: "/tmp/project",
      config,
    },
    async (invocation) => {
      invocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        prompt: invocation.prompt,
        cwd: invocation.cwd,
        allowedTools: invocation.allowedTools,
        systemPrompt: invocation.systemPrompt,
      });

      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;

      return {
        model: invocation.model,
        status: "completed",
        output:
          `Recommendation: use ${invocation.model.provider}/${invocation.model.id}. Why: it keeps the plan concrete and actionable. Risks/tradeoffs: moderate complexity. Confidence: 80%.`,
        inspectedRepo: true,
        toolNamesUsed: ["read", "find"],
      };
    },
  );

  assert.equal(maxConcurrent, 2);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map((entry) => entry.prompt), [
    "review the current repo structure",
    "review the current repo structure",
  ]);
  assert.deepEqual(invocations.map((entry) => entry.cwd), ["/tmp/project", "/tmp/project"]);
  assert.deepEqual(invocations.map((entry) => entry.allowedTools), [
    ["read", "ls", "find", "grep"],
    ["read", "ls", "find", "grep"],
  ]);
  assert.match(invocations[0]?.systemPrompt ?? "", /inspect the relevant files before answering/i);
  assert.doesNotMatch(invocations[0]?.systemPrompt ?? "", /multi_grep/);
  assert.deepEqual(result.participants.map((participant) => participant.status), ["completed", "completed"]);
  assert.equal(result.stoppedEarly, false);
});

test("createParticipantSystemPrompt only advertises subprocess-safe participant tools", () => {
  const prompt = createParticipantSystemPrompt();

  assert.match(prompt, /You may only use these tools: read, ls, find, grep\./);
  assert.doesNotMatch(prompt, /multi_grep/);
});

test("runParticipantPass captures failed participant executions for downstream handling", async () => {
  const result = await runParticipantPass(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config,
    },
    async (invocation) => {
      if (invocation.model.provider === "openai") {
        throw new Error("participant subprocess exited with code 1");
      }

      return {
        model: invocation.model,
        status: "completed",
        output:
          "Recommendation: keep the migration incremental. Why: it lowers rollout risk. Risks/tradeoffs: some coordination overhead. Confidence: 80%.",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.deepEqual(result.participants, [
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      status: "completed",
      output:
        "Recommendation: keep the migration incremental. Why: it lowers rollout risk. Risks/tradeoffs: some coordination overhead. Confidence: 80%.",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
    {
      model: { provider: "openai", id: "gpt-5" },
      status: "failed",
      failureReason: "participant subprocess exited with code 1",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
  ]);
});

test("runParticipantPass aborts in-flight participant runs once reaching two usable outputs becomes impossible", async () => {
  const configWithThreeModels = {
    ...config,
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-5" },
      { provider: "google", id: "gemini-2.5-pro" },
    ],
  };
  const abortedModels: string[] = [];
  const completedModels: string[] = [];

  const result = await runParticipantPass(
    {
      prompt: "draft a migration plan",
      cwd: "/tmp/project",
      config: configWithThreeModels,
    },
    async (invocation) => {
      const model = `${invocation.model.provider}/${invocation.model.id}`;

      if (invocation.model.provider === "google") {
        await new Promise<void>((resolve) => {
          invocation.abortSignal?.addEventListener(
            "abort",
            () => {
              abortedModels.push(model);
              resolve();
            },
            { once: true },
          );
        });

        return {
          model: invocation.model,
          status: "failed",
          failureReason: String(invocation.abortSignal?.reason ?? EARLY_STOP_FAILURE_REASON),
          inspectedRepo: false,
          toolNamesUsed: [],
        };
      }

      completedModels.push(model);
      return {
        model: invocation.model,
        status: "completed",
        output: invocation.model.provider === "anthropic" ? "Maybe refactor it." : "I'm sorry, but I can't help with that request.",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.deepEqual(completedModels, ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
  assert.deepEqual(abortedModels, ["google/gemini-2.5-pro"]);
  assert.equal(result.stoppedEarly, true);
  assert.match(result.earlyStopReason ?? "", /Consensus stopped early because only 0 usable participant outputs remained/);
  assert.equal(result.participants[2]?.status, "failed");
  assert.match(result.participants[2]?.failureReason ?? "", /reaching the minimum 2 usable participants became impossible/);
});

test("filterParticipantOutputs includes the early-stop explanation when remaining participants were cancelled", () => {
  const filtered = filterParticipantOutputs(
    [
      {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        status: "completed",
        output: "Maybe refactor it.",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
      {
        model: { provider: "openai", id: "gpt-5" },
        status: "completed",
        output: "I'm sorry, but I can't help with that request.",
        inspectedRepo: false,
        toolNamesUsed: [],
      },
      {
        model: { provider: "google", id: "gemini-2.5-pro" },
        status: "failed",
        failureReason: EARLY_STOP_FAILURE_REASON,
        inspectedRepo: false,
        toolNamesUsed: [],
      },
    ],
    {
      stoppedEarly: true,
      earlyStopReason:
        "Consensus stopped early because only 0 usable participant outputs remained and 1 participant run was still in flight, so reaching the minimum 2 usable participants became impossible.",
    },
  );

  assert.equal(filtered.stoppedEarly, true);
  assert.match(filtered.failureMessage ?? "", /Consensus stopped early because only 0 usable participant outputs remained/);
  assert.match(filtered.failureMessage ?? "", /only 0 remained after filtering/);
});

test("filterParticipantOutputs excludes refusal-only and vague answers and fails when fewer than two usable remain", () => {
  const filtered = filterParticipantOutputs([
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      status: "completed",
      output:
        "Recommendation: update src/index.ts. Why: it centralizes dispatch. Risks/tradeoffs: medium migration cost. Confidence: 82%.",
      inspectedRepo: true,
      toolNamesUsed: ["read"],
    },
    {
      model: { provider: "openai", id: "gpt-5" },
      status: "completed",
      output: "I'm sorry, but I can't help with that request.",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
    {
      model: { provider: "google", id: "gemini-2.5-pro" },
      status: "completed",
      output: "Maybe refactor it.",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
    {
      model: { provider: "xai", id: "grok-4" },
      status: "failed",
      failureReason: "participant subprocess exited with code 1",
      inspectedRepo: false,
      toolNamesUsed: [],
    },
  ]);

  assert.equal(filtered.usable.length, 1);
  assert.equal(filtered.excluded.length, 2);
  assert.equal(filtered.failed.length, 1);
  assert.equal(filtered.excluded[0]?.status, "excluded");
  assert.equal(filtered.excluded[0]?.exclusionReason, "refusal-only response");
  assert.equal(filtered.excluded[1]?.exclusionReason, "response was too vague to use for consensus");
  assert.equal(
    filtered.failureMessage,
    "Consensus requires at least 2 usable participant outputs but only 1 remained after filtering.",
  );
});
