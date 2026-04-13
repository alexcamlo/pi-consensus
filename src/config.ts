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

type RawModelRef = string | { provider?: unknown; id?: unknown; contextWindow?: unknown; stance?: unknown; focus?: unknown };

export const DEFAULT_PARTICIPANT_CONCURRENCY = 3;
export const DEFAULT_PARTICIPANT_MAX_RETRIES = 1;
export const DEFAULT_SYNTHESIS_MAX_RETRIES = 1;

type RawConsensusConfig = {
  models?: unknown;
  synthesisModel?: unknown;
  participantThinking?: unknown;
  synthesisThinking?: unknown;
  participantTimeoutMs?: unknown;
  synthesisTimeoutMs?: unknown;
  participantConcurrency?: unknown;
  participantMaxRetries?: unknown;
  synthesisMaxRetries?: unknown;
};

export const STANCE_VALUES = ["for", "against", "neutral"] as const;
export const FOCUS_VALUES = ["security", "performance", "maintainability", "implementation speed", "user value"] as const;

export type Stance = (typeof STANCE_VALUES)[number];
export type Focus = (typeof FOCUS_VALUES)[number];

export type ConsensusModelRef = {
  provider: string;
  id: string;
  contextWindow?: number;
  stance?: Stance;
  focus?: Focus;
};

export type ConsensusConfig = {
  models: ConsensusModelRef[];
  synthesisModel?: ConsensusModelRef;
  participantThinking?: ThinkingLevel;
  synthesisThinking?: ThinkingLevel;
  participantTimeoutMs?: number;
  synthesisTimeoutMs?: number;
  participantConcurrency?: number;
  participantMaxRetries?: number;
  synthesisMaxRetries?: number;
};

export type ResolvedConsensusConfig = Omit<ConsensusConfig, "synthesisModel"> & {
  configPath: string;
  configSource: "project" | "global";
  synthesisModel: ConsensusModelRef;
  participantConcurrency: number;
  participantMaxRetries: number;
  synthesisMaxRetries: number;
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
  const participantConcurrency = normalizeConcurrency(rawConfig.participantConcurrency, "participantConcurrency");
  const participantMaxRetries = normalizeMaxRetries(rawConfig.participantMaxRetries, "participantMaxRetries");
  const synthesisMaxRetries = normalizeMaxRetries(rawConfig.synthesisMaxRetries, "synthesisMaxRetries");

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
    participantConcurrency,
    participantMaxRetries,
    synthesisMaxRetries,
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
        `Consensus config field "${fieldName}" must use "provider/id" strings or { provider, id, contextWindow?, stance?, focus? } objects.`,
      );
    }
    return { provider: parts[0], id: parts[1] };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const model = value as RawModelRef & { provider?: unknown; id?: unknown; contextWindow?: unknown; stance?: unknown; focus?: unknown };
    if (typeof model.provider === "string" && typeof model.id === "string" && model.provider && model.id) {
      return {
        provider: model.provider,
        id: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: normalizeContextWindow(model.contextWindow, fieldName) }),
        ...(model.stance === undefined ? {} : { stance: normalizeStance(model.stance, fieldName) }),
        ...(model.focus === undefined ? {} : { focus: normalizeFocus(model.focus, fieldName) }),
      };
    }
  }

  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}" must use "provider/id" strings or { provider, id, contextWindow?, stance?, focus? } objects.`,
  );
}

function normalizeStance(value: unknown, fieldName: string): Stance {
  if (typeof value === "string" && STANCE_VALUES.includes(value as Stance)) {
    return value as Stance;
  }
  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}.stance" must be one of: ${STANCE_VALUES.join(", ")}.`,
  );
}

function normalizeFocus(value: unknown, fieldName: string): Focus {
  if (typeof value === "string" && FOCUS_VALUES.includes(value as Focus)) {
    return value as Focus;
  }
  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}.focus" must be one of: ${FOCUS_VALUES.join(", ")}.`,
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

function normalizeConcurrency(value: unknown, fieldName: string): number {
  if (value === undefined) {
    return DEFAULT_PARTICIPANT_CONCURRENCY;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PARTICIPANTS) {
    return value;
  }
  throw new ConsensusConfigError(
    `Consensus config field "${fieldName}" must be an integer between 1 and ${MAX_PARTICIPANTS}.`,
  );
}

function normalizeMaxRetries(value: unknown, fieldName: string): number {
  if (value === undefined) {
    return DEFAULT_PARTICIPANT_MAX_RETRIES;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) {
    return value;
  }
  throw new ConsensusConfigError(`Consensus config field "${fieldName}" must be an integer between 0 and 3.`);
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
