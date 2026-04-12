import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConsensusConfigError, loadConsensusConfig } from "../src/config.ts";

test("loadConsensusConfig preserves optional contextWindow metadata for object-form model refs", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-context-window-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          contextWindow: 200000,
        },
        "openai/gpt-5",
      ],
      synthesisModel: {
        provider: "openai",
        id: "gpt-5",
        contextWindow: 400000,
      },
    }),
  );

  const config = loadConsensusConfig({
    cwd: projectDir,
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-5" },
    ],
    currentModel: { provider: "openai", id: "gpt-5" },
  });

  assert.deepEqual(config.models, [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      contextWindow: 200000,
    },
    {
      provider: "openai",
      id: "gpt-5",
    },
  ]);
  assert.deepEqual(config.synthesisModel, {
    provider: "openai",
    id: "gpt-5",
    contextWindow: 400000,
  });
});

test("loadConsensusConfig rejects invalid contextWindow metadata", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-invalid-context-window-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          contextWindow: "128000",
        },
        "openai/gpt-5",
      ],
    }),
  );

  assert.throws(
    () =>
      loadConsensusConfig({
        cwd: projectDir,
        availableModels: [
          { provider: "anthropic", id: "claude-sonnet-4-5" },
          { provider: "openai", id: "gpt-5" },
        ],
        currentModel: { provider: "openai", id: "gpt-5" },
      }),
    (error) => {
      assert.ok(error instanceof ConsensusConfigError);
      assert.match(error.message, /contextWindow/);
      return true;
    },
  );
});
