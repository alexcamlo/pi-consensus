import assert from "node:assert/strict";
import test from "node:test";

import { runParticipantPass } from "../src/participants.ts";

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

test("runParticipantPass executes participant invocations in parallel with read-only settings", async () => {
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
        output: `answer from ${invocation.model.provider}/${invocation.model.id}`,
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
  assert.deepEqual(result.participants.map((participant) => participant.status), ["completed", "completed"]);
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
        output: "usable answer",
        inspectedRepo: false,
        toolNamesUsed: [],
      };
    },
  );

  assert.deepEqual(result.participants, [
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      status: "completed",
      output: "usable answer",
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
