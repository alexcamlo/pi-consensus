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
  participantConcurrency: 3,
  participantMaxRetries: 1,
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

test("runParticipantPass passes stance and focus through to participant system prompts", async () => {
  const invocations: Array<{
    model: string;
    systemPrompt: string;
  }> = [];

  const configWithStanceFocus = {
    configPath: ".pi/consensus.json",
    configSource: "project" as const,
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", stance: "for" as const, focus: "security" as const },
      { provider: "openai", id: "gpt-5", stance: "against" as const },
    ],
    synthesisModel: { provider: "openai", id: "gpt-5" },
    participantConcurrency: 3,
    participantMaxRetries: 1,
    warnings: [],
  };

  await runParticipantPass(
    {
      prompt: "evaluate this authentication approach",
      cwd: "/tmp/project",
      config: configWithStanceFocus,
    },
    async (invocation) => {
      invocations.push({
        model: `${invocation.model.provider}/${invocation.model.id}`,
        systemPrompt: invocation.systemPrompt,
      });

      return {
        model: invocation.model,
        status: "completed",
        output: "Recommendation: proceed. Why: secure design. Risks/tradeoffs: minimal. Confidence: 85%.",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.equal(invocations.length, 2);

  // First model has stance "for" and focus "security"
  assert.match(invocations[0].systemPrompt, /Stance: Supportive/);
  assert.match(invocations[0].systemPrompt, /Focus: Security/);
  assert.match(invocations[0].systemPrompt, /Truthfulness guardrail/);

  // Second model has stance "against" only
  assert.match(invocations[1].systemPrompt, /Stance: Critical/);
  assert.doesNotMatch(invocations[1].systemPrompt, /Focus:/);
  assert.match(invocations[1].systemPrompt, /Truthfulness guardrail/);
});

test("createParticipantSystemPrompt only advertises subprocess-safe participant tools", () => {
  const prompt = createParticipantSystemPrompt();

  assert.match(prompt, /You may only use these tools: read, ls, find, grep\./);
  assert.doesNotMatch(prompt, /multi_grep/);
});

test("createParticipantSystemPrompt requires structured response with all required sections", () => {
  const prompt = createParticipantSystemPrompt();

  assert.match(prompt, /Your response must include all of the following sections/i);
  assert.match(prompt, /Recommendation:.*clear, actionable recommendation/i);
  assert.match(prompt, /Why:.*Rationale explaining your reasoning/i);
  assert.match(prompt, /Risks\/tradeoffs:.*Potential downsides/i);
  assert.match(prompt, /Confidence:.*confidence level/i);
  assert.match(prompt, /Repo evidence:.*cite specific files/i);
  assert.match(prompt, /vague or overly brief responses may be excluded/i);
});

test("createParticipantSystemPrompt forbids edits and writes", () => {
  const prompt = createParticipantSystemPrompt();

  assert.match(prompt, /Never edit or write files/i);
});

test("createParticipantSystemPrompt includes stance instructions for 'for' stance with truthfulness guardrail", () => {
  const prompt = createParticipantSystemPrompt("for");

  assert.match(prompt, /Your perspective for this consensus:/);
  assert.match(prompt, /Stance: Supportive/);
  assert.match(prompt, /Look for the merits and potential in the proposal/);
  assert.match(prompt, /You must still reject clearly bad ideas if the evidence is strong against them/);
  assert.match(prompt, /Truthfulness guardrail: Your stance and focus guide your emphasis, not your honesty/);
  assert.match(prompt, /If you are supportive but the evidence strongly opposes the proposal, you must reject it/);
});

test("createParticipantSystemPrompt includes stance instructions for 'against' stance with truthfulness guardrail", () => {
  const prompt = createParticipantSystemPrompt("against");

  assert.match(prompt, /Stance: Critical/);
  assert.match(prompt, /Scrutinize the proposal for risks, downsides, and alternatives/);
  assert.match(prompt, /but acknowledge genuinely good aspects if the evidence supports them/);
  assert.match(prompt, /If you are critical but the evidence strongly supports the proposal, you must acknowledge this/);
});

test("createParticipantSystemPrompt includes stance instructions for 'neutral' stance with evidence-based guidance", () => {
  const prompt = createParticipantSystemPrompt("neutral");

  assert.match(prompt, /Stance: Neutral/);
  assert.match(prompt, /Evaluate based on the actual weight of evidence/);
  assert.match(prompt, /Do not artificially balance pros and cons/);
  assert.match(prompt, /if the evidence clearly favors one side, say so/);
  assert.match(prompt, /Represent the evidence as it is/);
});

test("createParticipantSystemPrompt includes focus instructions for each focus dimension", () => {
  const focuses = ["security", "performance", "maintainability", "implementation speed", "user value"] as const;

  for (const focus of focuses) {
    const prompt = createParticipantSystemPrompt(undefined, focus);

    assert.match(prompt, /Your perspective for this consensus:/);
    assert.match(prompt, new RegExp(`Focus: ${focus.charAt(0).toUpperCase() + focus.slice(1)}`));
    assert.match(prompt, new RegExp(`Prioritize evaluating this proposal from the perspective of ${focus}`));
    assert.match(prompt, new RegExp(`Consider how the recommendation affects ${focus} above other dimensions`));
  }
});

test("createParticipantSystemPrompt includes both stance and focus when both are provided", () => {
  const prompt = createParticipantSystemPrompt("for", "security");

  assert.match(prompt, /Stance: Supportive/);
  assert.match(prompt, /Focus: Security/);
  assert.match(prompt, /Prioritize evaluating this proposal from the perspective of security/);
  assert.match(prompt, /Truthfulness guardrail: Your stance and focus guide your emphasis, not your honesty/);
});

test("createParticipantSystemPrompt does not include stance/focus sections when neither is provided", () => {
  const prompt = createParticipantSystemPrompt();

  assert.doesNotMatch(prompt, /Your perspective for this consensus:/);
  assert.doesNotMatch(prompt, /Stance:/);
  assert.doesNotMatch(prompt, /Focus:/);
  assert.doesNotMatch(prompt, /Truthfulness guardrail/);
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

import { isTransientFailure } from "../src/participants.ts";

test("isTransientFailure identifies timeout, transport, and network errors as transient", () => {
  assert.equal(isTransientFailure("participant subprocess timed out after 30000ms"), true);
  assert.equal(isTransientFailure("socket hang up"), true);
  assert.equal(isTransientFailure("ECONNRESET"), true);
  assert.equal(isTransientFailure("connection refused"), true);
  assert.equal(isTransientFailure("rate limit exceeded"), true);
  assert.equal(isTransientFailure("temporarily unavailable"), true);
  assert.equal(isTransientFailure("network error occurred"), true);
});

test("isTransientFailure does not identify non-transient errors as transient", () => {
  assert.equal(isTransientFailure("participant subprocess exited with code 1"), false);
  assert.equal(isTransientFailure("invalid model configuration"), false);
  assert.equal(isTransientFailure("authentication failed"), false);
  assert.equal(isTransientFailure("model not found"), false);
});

test("runParticipantPass respects bounded concurrency configuration", async () => {
  const configWithConcurrency1 = {
    ...config,
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-5" },
      { provider: "google", id: "gemini-2.5-pro" },
    ],
    participantConcurrency: 1,
  };

  let concurrent = 0;
  let maxConcurrent = 0;
  const startTimes: number[] = [];

  const result = await runParticipantPass(
    {
      prompt: "review code",
      cwd: "/tmp/project",
      config: configWithConcurrency1,
    },
    async () => {
      startTimes.push(Date.now());
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return {
        model: { provider: "test", id: "model" },
        status: "completed" as const,
        output: "Recommendation: proceed. Why: clear benefits.",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.equal(maxConcurrent, 1, "max concurrent should be 1 when concurrency is capped at 1");
  assert.equal(result.participants.length, 3);
});

test("runParticipantPass retries transient failures once and succeeds on retry", async () => {
  const attemptsByModel = new Map<string, number>();
  const configWithRetry = {
    ...config,
    participantMaxRetries: 1,
  };

  const result = await runParticipantPass(
    {
      prompt: "review code",
      cwd: "/tmp/project",
      config: configWithRetry,
    },
    async (invocation) => {
      const modelKey = `${invocation.model.provider}/${invocation.model.id}`;
      const currentAttempt = (attemptsByModel.get(modelKey) ?? 0) + 1;
      attemptsByModel.set(modelKey, currentAttempt);

      // First model: first attempt fails with transient error, retry succeeds
      if (modelKey === "anthropic/claude-sonnet-4-5" && currentAttempt === 1) {
        return {
          model: invocation.model,
          status: "failed" as const,
          failureReason: "participant subprocess timed out after 30000ms",
          inspectedRepo: false,
          toolNamesUsed: [],
        };
      }

      // All other cases succeed
      return {
        model: invocation.model,
        status: "completed" as const,
        output: "Recommendation: proceed.",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  // anthropic model: 2 attempts (1 fail + 1 retry succeed)
  // openai model: 1 attempt (succeed immediately)
  assert.equal(attemptsByModel.get("anthropic/claude-sonnet-4-5"), 2, "anthropic model should be retried once");
  assert.equal(attemptsByModel.get("openai/gpt-5"), 1, "openai model should not need retry");
  assert.equal(result.participants[0]?.status, "completed");
  assert.equal(result.participants[1]?.status, "completed");
});

test("runParticipantPass does not retry non-transient failures", async () => {
  let attemptCount = 0;
  const configWithRetry = {
    ...config,
    participantMaxRetries: 1,
  };

  const result = await runParticipantPass(
    {
      prompt: "review code",
      cwd: "/tmp/project",
      config: configWithRetry,
    },
    async (invocation) => {
      attemptCount++;
      return {
        model: invocation.model,
        status: "failed" as const,
        failureReason: "participant subprocess exited with code 1",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.equal(attemptCount, 2, "should attempt both participants once each, no retries for non-transient");
  assert.equal(result.participants[0]?.status, "failed");
  assert.equal(result.participants[1]?.status, "failed");
});

test("runParticipantPass exhausts retries and returns last failure for persistent transient errors", async () => {
  let attemptCount = 0;
  const configWithRetry = {
    ...config,
    participantMaxRetries: 1,
  };

  const result = await runParticipantPass(
    {
      prompt: "review code",
      cwd: "/tmp/project",
      config: configWithRetry,
    },
    async (invocation) => {
      attemptCount++;
      // Always fail with transient error
      return {
        model: invocation.model,
        status: "failed" as const,
        failureReason: "participant subprocess timed out after 30000ms",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  // 2 participants, each retried once = 4 total attempts
  assert.equal(attemptCount, 4, "should exhaust retries for both participants");
  assert.equal(result.participants[0]?.status, "failed");
  assert.equal(result.participants[1]?.status, "failed");
});
