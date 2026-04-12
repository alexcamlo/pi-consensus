import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 8;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type ModelLike = {
  provider: string;
  id: string;
};

type RawModelRef = string | { provider?: unknown; id?: unknown; contextWindow?: unknown };

type RawConsensusConfig = {
  models?: unknown;
  synthesisModel?: unknown;
  participantThinking?: unknown;
  synthesisThinking?: unknown;
  participantTimeoutMs?: unknown;
  synthesisTimeoutMs?: unknown;
};

export type ConsensusModelRef = {
  provider: string;
  id: string;
  contextWindow?: number;
};

export type ConsensusConfig = {
  models: ConsensusModelRef[];
  synthesisModel?: ConsensusModelRef;
  participantThinking?: ThinkingLevel;
  synthesisThinking?: ThinkingLevel;
  participantTimeoutMs?: number;
  synthesisTimeoutMs?: number;
};

export type ResolvedConsensusConfig = Omit<ConsensusConfig, "synthesisModel"> & {
  configPath: string;
  configSource: "project" | "global";
  synthesisModel: ConsensusModelRef;
  warnings: string[];
};

export class ConsensusConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsensusConfigError";
  }
}

export function resolveConsensusConfigPath(cwd: string, agentDir = getAgentDir()) {
  const projectPath = join(cwd, ".pi", "consensus.json");
  if (existsSync(projectPath)) {
    return { path: projectPath, source: "project" as const };
  }

  const globalPath = join(agentDir, "consensus.json");
  if (existsSync(globalPath)) {
    return { path: globalPath, source: "global" as const };
  }

  throw new ConsensusConfigError(
    "Consensus config not found. Create .pi/consensus.json or ~/.pi/agent/consensus.json with at least 2 participant models.",
  );
}

export function loadConsensusConfig(options: {
  cwd: string;
  agentDir?: string;
  availableModels: ModelLike[];
  currentModel?: ModelLike;
}): ResolvedConsensusConfig {
  const { path, source } = resolveConsensusConfigPath(options.cwd, options.agentDir);
  const rawJson = readFileSync(path, "utf-8");

  let rawConfig: RawConsensusConfig;
  try {
    rawConfig = JSON.parse(rawJson) as RawConsensusConfig;
  } catch (error) {
    throw new ConsensusConfigError(
      `Failed to parse consensus config at "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new ConsensusConfigError(`Consensus config at "${path}" must be a JSON object.`);
  }

  const warnings: string[] = [];
  const participants = normalizeParticipantModels(rawConfig.models, warnings);
  if (participants.length < MIN_PARTICIPANTS) {
    throw new ConsensusConfigError("Consensus config must contain at least 2 unique participant models.");
  }

  if (participants.length > MAX_PARTICIPANTS) {
    throw new ConsensusConfigError(
      `Consensus config supports at most ${MAX_PARTICIPANTS} unique participant models for safety.`,
    );
  }

  validateModelsAvailable(participants, options.availableModels, "participant");

  const participantThinking = normalizeThinkingLevel(rawConfig.participantThinking, "participantThinking");
  const synthesisThinking = normalizeThinkingLevel(rawConfig.synthesisThinking, "synthesisThinking");
  const participantTimeoutMs = normalizeTimeout(rawConfig.participantTimeoutMs, "participantTimeoutMs");
  const synthesisTimeoutMs = normalizeTimeout(rawConfig.synthesisTimeoutMs, "synthesisTimeoutMs");

  const synthesisModel = resolveSynthesisModel({
    rawSynthesisModel: rawConfig.synthesisModel,
    currentModel: options.currentModel,
    availableModels: options.availableModels,
    participantModels: participants,
    warnings,
  });

  return {
    configPath: path,
    configSource: source,
    models: participants,
    synthesisModel,
    participantThinking,
    synthesisThinking,
    participantTimeoutMs,
    synthesisTimeoutMs,
    warnings,
  };
}

function normalizeParticipantModels(rawModels: unknown, warnings: string[]): ConsensusModelRef[] {
  if (!Array.isArray(rawModels)) {
    throw new ConsensusConfigError("Consensus config field " + '"models" must be an array of model references.');
  }

  const participants: ConsensusModelRef[] = [];
  const seen = new Set<string>();

  for (const entry of rawModels) {
    const model = normalizeModelRef(entry, "models");
    const key = formatModelRef(model);
    if (seen.has(key)) {
      warnings.push(`Duplicate participant model "${key}" was deduplicated.`);
      continue;
    }
    seen.add(key);
    participants.push(model);
  }

  return participants;
}

function resolveSynthesisModel(options: {
  rawSynthesisModel: unknown;
  currentModel?: ModelLike;
  availableModels: ModelLike[];
  participantModels: ConsensusModelRef[];
  warnings: string[];
}): ConsensusModelRef {
  const { rawSynthesisModel, currentModel, availableModels, participantModels, warnings } = options;
  let synthesisModel: ConsensusModelRef | undefined;

  if (rawSynthesisModel !== undefined) {
    const configuredModel = normalizeModelRef(rawSynthesisModel, "synthesisModel");
    if (isModelAvailable(configuredModel, availableModels)) {
      synthesisModel = configuredModel;
    } else {
      const fallback = resolveCurrentModelFallback(currentModel, availableModels);
      warnings.push(
        `Configured synthesis model "${formatModelRef(configuredModel)}" is unavailable; falling back to current model "${formatModelRef(fallback)}".`,
      );
      synthesisModel = fallback;
    }
  } else {
    synthesisModel = resolveCurrentModelFallback(currentModel, availableModels);
  }

  if (participantModels.some((model) => sameModel(model, synthesisModel))) {
    warnings.push(`Synthesis model "${formatModelRef(synthesisModel)}" is also configured as a participant.`);
  }

  return synthesisModel;
}

function resolveCurrentModelFallback(currentModel: ModelLike | undefined, availableModels: ModelLike[]) {
  if (!currentModel || typeof currentModel.provider !== "string" || typeof currentModel.id !== "string") {
    throw new ConsensusConfigError(
      "Consensus synthesis model is missing or invalid, and the current pi model is unavailable for fallback.",
    );
  }

  const normalizedCurrentModel = {
    provider: currentModel.provider,
    id: currentModel.id,
  } satisfies ConsensusModelRef;

  if (!isModelAvailable(normalizedCurrentModel, availableModels)) {
    throw new ConsensusConfigError(
      `Consensus synthesis model is unavailable and current pi model "${formatModelRef(normalizedCurrentModel)}" is unavailable for fallback.`,
    );
  }

  return normalizedCurrentModel;
}

function validateModelsAvailable(models: ConsensusModelRef[], availableModels: ModelLike[], label: string) {
  for (const model of models) {
    if (!isModelAvailable(model, availableModels)) {
      throw new ConsensusConfigError(`Configured ${label} model "${formatModelRef(model)}" is unavailable.`);
    }
  }
}

function normalizeModelRef(value: unknown, fieldName: string): ConsensusModelRef {
  if (typeof value === "string") {
    const parts = value.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ConsensusConfigError(
        `Consensus config field "${fieldName}" must use "provider/id" strings or { provider, id, contextWindow? } objects.`,
      );
    }
    return { provider: parts[0], id: parts[1] };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const model = value as RawModelRef & { provider?: unknown; id?: unknown; contextWindow?: unknown };
    if (typeof model.provider === "string" && typeof model.id === "string" && model.provider && model.id) {
      return {
        provider: model.provider,
        id: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: normalizeContextWindow(model.contextWindow, fieldName) }),
      };
    }
  }

  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}" must use "provider/id" strings or { provider, id, contextWindow? } objects.`,
  );
}

function normalizeContextWindow(value: unknown, fieldName: string) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}.contextWindow" must be a positive integer number of tokens.`,
  );
}

function normalizeThinkingLevel(value: unknown, fieldName: string): ThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}" must be one of: ${THINKING_LEVELS.join(", ")}.`,
  );
}

function normalizeTimeout(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new ConsensusConfigError(`Consensus config field "${fieldName}" must be a positive number of milliseconds.`);
}

function isModelAvailable(model: ConsensusModelRef, availableModels: ModelLike[]) {
  return availableModels.some((candidate) => sameModel(candidate, model));
}

function sameModel(a: ModelLike, b: ModelLike) {
  return a.provider === b.provider && a.id === b.id;
}

export function formatModelRef(model: ConsensusModelRef) {
  return `${model.provider}/${model.id}`;
}
