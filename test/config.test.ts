import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConsensusConfigError,
  DEFAULT_PARTICIPANT_CONCURRENCY,
  DEFAULT_PARTICIPANT_MAX_RETRIES,
  loadConsensusConfig,
} from "../src/config.ts";

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

test("loadConsensusConfig applies default values for participantConcurrency and participantMaxRetries", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-defaults-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
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

  assert.equal(config.participantConcurrency, DEFAULT_PARTICIPANT_CONCURRENCY);
  assert.equal(config.participantMaxRetries, DEFAULT_PARTICIPANT_MAX_RETRIES);
});

test("loadConsensusConfig accepts custom participantConcurrency and participantMaxRetries values", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-custom-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      participantConcurrency: 2,
      participantMaxRetries: 0,
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

  assert.equal(config.participantConcurrency, 2);
  assert.equal(config.participantMaxRetries, 0);
});

test("loadConsensusConfig rejects invalid participantConcurrency values", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-invalid-concurrency-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      participantConcurrency: 0,
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
      assert.match(error.message, /participantConcurrency/);
      return true;
    },
  );
});

test("loadConsensusConfig rejects invalid participantMaxRetries values", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-invalid-retries-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      participantMaxRetries: 5,
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
      assert.match(error.message, /participantMaxRetries/);
      return true;
    },
  );
});

test("loadConsensusConfig applies default value for synthesisMaxRetries", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-synthesis-defaults-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
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

  assert.equal(config.synthesisMaxRetries, 1);
});

test("loadConsensusConfig accepts custom synthesisMaxRetries value", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-synthesis-custom-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      synthesisMaxRetries: 0,
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

  assert.equal(config.synthesisMaxRetries, 0);
});

test("loadConsensusConfig rejects invalid synthesisMaxRetries values", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-consensus-config-invalid-synthesis-retries-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "consensus.json"),
    JSON.stringify({
      models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      synthesisMaxRetries: 5,
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
      assert.match(error.message, /synthesisMaxRetries/);
      return true;
    },
  );
});
