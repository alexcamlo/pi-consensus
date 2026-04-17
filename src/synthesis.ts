import { formatModelRef, type ConsensusModelRef, type ResolvedConsensusConfig } from "./config.ts";
import {
  parsePiJsonEventLine,
  readAssistantTextFromMessageEndEvent,
} from "./pi-json-events.ts";
import { runPiInvocation, type PiInvocationRunner } from "./invocation-runner.ts";
import { isTransientFailure, type ExcludedParticipantResult, type FailedParticipantResult, type UsableParticipantResult } from "./participants.ts";

export type ConsensusPoint = {
  point: string;
  supportPercent: number;
  supportingParticipants: number;
  totalParticipants: number;
};

export type ConsensusDisagreement = {
  point: string;
  summary: string;
};

export type ConsensusParticipantSummary = {
  model: string;
  summary: string;
};

export type ConsensusExcludedParticipantSummary = {
  model: string;
  reason: string;
};

export type ConsensusSynthesisOutput = {
  consensusAnswer: string;
  overallAgreementPercent: number;
  overallDisagreementPercent: number;
  overallUnclearPercent: number;
  confidencePercent: number;
  confidenceLabel: string;
  agreedPoints: ConsensusPoint[];
  disagreements: ConsensusDisagreement[];
  participants: ConsensusParticipantSummary[];
  excludedParticipants: ConsensusExcludedParticipantSummary[];
};

export type SynthesisInvocation = {
  model: ConsensusModelRef;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  thinking?: ResolvedConsensusConfig["synthesisThinking"];
  timeoutMs?: number;
  piCommand?: string;
  env?: NodeJS.ProcessEnv;
};

export type SynthesisInvocationResult = {
  model: ConsensusModelRef;
  output: ConsensusSynthesisOutput;
  rawOutputText?: string;
};

export type SynthesisExecutionResult =
  | {
      status: "complete";
      model: ConsensusModelRef;
      output: ConsensusSynthesisOutput;
      rawOutputText?: string;
    }
  | {
      status: "degraded";
      model: ConsensusModelRef;
      output: ConsensusSynthesisOutput;
      rawOutputText: string;
      degradedText: string;
    };

export type NormalizedSynthesisResult =
  | { status: "full"; output: ConsensusSynthesisOutput }
  | { status: "extracted"; output: ConsensusSynthesisOutput }
  | { status: "normalized"; output: ConsensusSynthesisOutput }
  | { status: "unrecoverable"; output?: undefined };

export type SynthesisInvocationExecutor = (invocation: SynthesisInvocation) => Promise<SynthesisInvocationResult>;

export class InvalidConsensusSynthesisOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConsensusSynthesisOutputError";
  }
}

export function extractJsonFromMixedOutput(text: string): string | undefined {
  // Look for JSON code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Look for JSON object boundaries
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0].trim();
  }

  return undefined;
}

export function coerceNumericStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const num = Number(value);
    if (!Number.isNaN(num) && String(num) === value.trim()) {
      return num;
    }
  }

  if (Array.isArray(value)) {
    return value.map(coerceNumericStrings);
  }

  if (value && typeof value === "object") {
    const coerced: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      coerced[key] = coerceNumericStrings(val);
    }
    return coerced;
  }

  return value;
}

export function normalizeMissingOptionalArrays(output: ConsensusSynthesisOutput): ConsensusSynthesisOutput {
  return {
    ...output,
    disagreements: output.disagreements ?? [],
    excludedParticipants: output.excludedParticipants ?? [],
  };
}

export function normalizePercentageDrift(output: ConsensusSynthesisOutput): ConsensusSynthesisOutput {
  // Round percentages to integers first (handles float inputs from model)
  const rounded = {
    ...output,
    overallAgreementPercent: Math.round(output.overallAgreementPercent),
    overallDisagreementPercent: Math.round(output.overallDisagreementPercent),
    overallUnclearPercent: Math.round(output.overallUnclearPercent),
  };

  const sum = rounded.overallAgreementPercent + rounded.overallDisagreementPercent + rounded.overallUnclearPercent;
  const drift = 100 - sum;

  if (drift === 0 || Math.abs(drift) > 2) {
    // No drift or drift too large to safely normalize
    return rounded;
  }

  // Distribute drift to largest percentage (arbitrary but deterministic)
  const percentages = [
    { key: "overallAgreementPercent" as const, value: rounded.overallAgreementPercent },
    { key: "overallDisagreementPercent" as const, value: rounded.overallDisagreementPercent },
    { key: "overallUnclearPercent" as const, value: rounded.overallUnclearPercent },
  ];
  percentages.sort((a, b) => b.value - a.value);

  const adjusted = { ...rounded };
  adjusted[percentages[0].key] = percentages[0].value + drift;

  return adjusted;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    
    if (aKeys.length !== bKeys.length) return false;
    
    for (const key of aKeys) {
      if (!bKeys.includes(key)) return false;
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  
  return false;
}

function roundPercentagesInOutput(output: Record<string, unknown>): Record<string, unknown> {
  const rounded = { ...output };
  if (typeof output.overallAgreementPercent === "number") {
    rounded.overallAgreementPercent = Math.round(output.overallAgreementPercent);
  }
  if (typeof output.overallDisagreementPercent === "number") {
    rounded.overallDisagreementPercent = Math.round(output.overallDisagreementPercent);
  }
  if (typeof output.overallUnclearPercent === "number") {
    rounded.overallUnclearPercent = Math.round(output.overallUnclearPercent);
  }
  if (Array.isArray(output.agreedPoints)) {
    rounded.agreedPoints = output.agreedPoints.map((p: unknown) => {
      if (!p || typeof p !== "object") return p;
      const point = p as Record<string, unknown>;
      return {
        ...point,
        supportPercent: typeof point.supportPercent === "number" ? Math.round(point.supportPercent) : point.supportPercent,
      };
    });
  }
  return rounded;
}

export function normalizeSynthesisOutput(rawOutput: string): NormalizedSynthesisResult {
  // Try to extract JSON from mixed content
  const extractedJson = extractJsonFromMixedOutput(rawOutput);
  if (!extractedJson) {
    return { status: "unrecoverable" };
  }

  // Parse the extracted JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractedJson);
  } catch {
    return { status: "unrecoverable" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { status: "unrecoverable" };
  }

  const hadExtraction = extractedJson !== rawOutput.trim();

  // Coerce numeric strings to numbers
  const coerced = coerceNumericStrings(parsed) as Record<string, unknown>;
  const hadCoercion = !deepEqual(parsed, coerced);

  // Fill in missing optional arrays
  let hadArrayNormalization = false;
  if (coerced.disagreements === undefined) {
    coerced.disagreements = [];
    hadArrayNormalization = true;
  }
  if (coerced.excludedParticipants === undefined) {
    coerced.excludedParticipants = [];
    hadArrayNormalization = true;
  }

  // Round percentages before drift normalization (handles float inputs from models)
  const rounded = roundPercentagesInOutput(coerced);
  const hadRounding = !deepEqual(coerced, rounded);

  // Normalize percentage drift (e.g., 65+25+9=99 -> 66+25+9=100)
  const driftNormalized = normalizePercentageDrift(rounded as ConsensusSynthesisOutput);
  const hadDriftNormalization = !deepEqual(rounded, driftNormalized);

  // Try to validate the output
  try {
    validateSynthesisOutput(driftNormalized);

    if (hadExtraction) {
      return { status: "extracted", output: driftNormalized };
    }
    if (hadCoercion || hadArrayNormalization || hadRounding || hadDriftNormalization) {
      return { status: "normalized", output: driftNormalized };
    }
    return { status: "full", output: driftNormalized };
  } catch (error) {
    // Validation failed - check if we can still return a degraded result
    if (coerced.consensusAnswer && typeof coerced.consensusAnswer === "string") {
      return { status: "unrecoverable" };
    }
    return { status: "unrecoverable" };
  }
}

export async function runConsensusSynthesis(
  options: {
    prompt: string;
    cwd: string;
    config: ResolvedConsensusConfig;
    usableParticipants: UsableParticipantResult[];
    excludedParticipants: Array<ExcludedParticipantResult | FailedParticipantResult>;
  },
  executeSynthesisInvocation: SynthesisInvocationExecutor = runSynthesisInvocation,
  hooks: {
    onResponseReceived?: () => void;
    onValidationStarted?: () => void;
    onRepairStarted?: (validationError: string) => void;
    onRetry?: (attempt: number, maxAttempts: number, reason: string) => void;
    onDegraded?: () => void;
  } = {},
): Promise<SynthesisExecutionResult> {
  const invocation: SynthesisInvocation = {
    model: options.config.synthesisModel,
    cwd: options.cwd,
    prompt: createSynthesisPrompt(options.prompt, options.usableParticipants),
    systemPrompt: createSynthesisSystemPrompt(options.excludedParticipants),
    allowedTools: [],
    thinking: options.config.synthesisThinking,
    timeoutMs: options.config.synthesisTimeoutMs,
  };

  const maxRetries = options.config.synthesisMaxRetries;
  const result = await executeSynthesisInvocationWithRetry(invocation, executeSynthesisInvocation, maxRetries, hooks.onRetry);
  hooks.onResponseReceived?.();
  hooks.onValidationStarted?.();

  // Try normalization first (handles extraction, coercion, arrays).
  // Internal normalization variants are collapsed behind one stable caller-visible outcome.
  const normalized = normalizeSynthesisOutput(result.rawOutputText ?? JSON.stringify(result.output));
  if (normalized.status !== "unrecoverable") {
    return {
      status: "complete",
      model: result.model,
      output: normalized.output,
      rawOutputText: result.rawOutputText,
    };
  }

  // Try validation on the raw output
  let validationError: InvalidConsensusSynthesisOutputError | undefined;
  try {
    validateSynthesisOutput(result.output);
    return { ...result, status: "complete" };
  } catch (error) {
    if (error instanceof InvalidConsensusSynthesisOutputError) {
      validationError = error;
    } else {
      throw error;
    }
  }

  // Attempt repair
  hooks.onRepairStarted?.(validationError.message);

  const repairInvocation: SynthesisInvocation = {
    ...invocation,
    prompt: createSynthesisRepairPrompt(result.rawOutputText ?? JSON.stringify(result.output), validationError.message),
    systemPrompt: createSynthesisRepairSystemPrompt(),
  };

  let repairedResult: SynthesisInvocationResult;
  try {
    repairedResult = await executeSynthesisInvocation(repairInvocation);
  } catch (repairError) {
    // Repair subprocess failed - degrade to raw text if available
    hooks.onDegraded?.();
    return createDegradedResult(result.model, result.rawOutputText ?? "Synthesis failed to produce valid output.");
  }

  hooks.onValidationStarted?.();

  // Try normalization on repaired result
  const repairedNormalized = normalizeSynthesisOutput(repairedResult.rawOutputText ?? JSON.stringify(repairedResult.output));
  if (repairedNormalized.status !== "unrecoverable") {
    return {
      model: repairedResult.model,
      output: repairedNormalized.output,
      rawOutputText: repairedResult.rawOutputText,
      status: "complete",
    };
  }

  // Try validation on repaired output
  try {
    validateSynthesisOutput(repairedResult.output);
    return { ...repairedResult, status: "complete" };
  } catch {
    // Repair validation failed - degrade gracefully
    hooks.onDegraded?.();
    return createDegradedResult(
      result.model,
      repairedResult.rawOutputText ?? result.rawOutputText ?? "Synthesis failed to produce valid output.",
    );
  }
}

function createDegradedResult(model: ConsensusModelRef, rawText: string): SynthesisExecutionResult {
  return {
    model,
    status: "degraded",
    degradedText: rawText,
    rawOutputText: rawText,
    output: createFallbackSynthesisOutput(rawText),
  };
}

async function executeSynthesisInvocationWithRetry(
  invocation: SynthesisInvocation,
  executeSynthesisInvocation: SynthesisInvocationExecutor,
  maxRetries: number,
  onRetry?: (attempt: number, maxAttempts: number, reason: string) => void,
): Promise<SynthesisInvocationResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeSynthesisInvocation(invocation);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message;

      // Only retry transient failures, and only if we haven't exhausted retries
      if (attempt < maxRetries && isTransientFailure(errorMessage)) {
        onRetry?.(attempt + 2, maxRetries + 1, errorMessage);
        continue;
      }

      // Non-transient failure or exhausted retries
      throw lastError;
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error("Synthesis invocation failed after retries");
}

function createFallbackSynthesisOutput(rawText: string): ConsensusSynthesisOutput {
  return {
    consensusAnswer: rawText,
    overallAgreementPercent: 0,
    overallDisagreementPercent: 0,
    overallUnclearPercent: 100,
    confidencePercent: 0,
    confidenceLabel: "low (degraded mode - synthesis output was malformed)",
    agreedPoints: [],
    disagreements: [],
    participants: [],
    excludedParticipants: [],
  };
}

export function createSynthesisPrompt(
  prompt: string,
  usableParticipants: UsableParticipantResult[],
) {
  return [
    "Original user prompt:",
    '"""',
    prompt,
    '"""',
    "",
    "Usable participant outputs:",
    "",
    ...usableParticipants.flatMap((participant, index) => [
      `${index > 0 ? "" : ""}Participant: ${formatModelRef(participant.model)}`,
      participant.output,
      "",
    ]),
  ]
    .join("\n")
    .trim();
}

export function createSynthesisSystemPrompt(excludedParticipants: Array<ExcludedParticipantResult | FailedParticipantResult>) {
  // The synthesis prompt text is part of the output contract: it must steer models toward
  // schema-valid JSON with numeric fields emitted as numbers/integers, not stringified values.
  const excludedLines =
    excludedParticipants.length === 0
      ? ["Excluded participants: none"]
      : [
          "Excluded participants:",
          ...excludedParticipants.map((participant) => {
            const reason = participant.status === "failed" ? participant.failureReason : participant.exclusionReason;
            return `- ${formatModelRef(participant.model)} — ${reason ?? "excluded from synthesis"}`;
          }),
        ];

  return [
    "You are the synthesis model for a pi consensus workflow.",
    "Return valid JSON only with no markdown fences or commentary.",
    "Synthesize the original prompt and the full raw usable participant outputs into a single structured consensus result.",
    "Include: consensusAnswer, overallAgreementPercent, overallDisagreementPercent, overallUnclearPercent, confidencePercent, confidenceLabel, agreedPoints, disagreements, participants, excludedParticipants.",
    "agreement, disagreement, and unclear percentages that sum to 100 are required.",
    "All percentage and count fields must be JSON numbers, never strings.",
    "overallAgreementPercent, overallDisagreementPercent, overallUnclearPercent, confidencePercent, agreedPoints[].supportPercent, agreedPoints[].supportingParticipants, and agreedPoints[].totalParticipants are all required numeric fields.",
    "confidencePercent must be a number from 0 to 100 and confidenceLabel must be a short string.",
    "Each agreedPoints entry must include point, supportPercent, supportingParticipants, totalParticipants.",
    'supportingParticipants and totalParticipants must be non-negative JSON integers, never fractions like "2/3".',
    "Do not use null, omit required numeric fields, or encode numbers as quoted strings.",
    'Minimal valid agreedPoints entry example: {"point":"Prefer a staged rollout.","supportPercent":100,"supportingParticipants":2,"totalParticipants":2}.',
    "Each disagreements entry must include point and summary.",
    "Each participants entry must include model and summary.",
    "Each excludedParticipants entry must include model and reason.",
    ...excludedLines,
  ].join(" ");
}

export function createSynthesisRepairPrompt(invalidJson: string, validationError: string) {
  return [
    "The previous synthesis JSON failed validation.",
    "Return corrected JSON only with no markdown fences or commentary.",
    "Preserve the same overall meaning when possible and fix only what is required for schema validity.",
    "Validation error:",
    validationError,
    "",
    "Original invalid JSON:",
    invalidJson,
  ].join("\n");
}

export function createSynthesisRepairSystemPrompt() {
  return [
    "You are repairing previously generated JSON for a pi consensus workflow.",
    "Return corrected JSON only with no markdown fences or commentary.",
    "Use the provided validation error to repair the JSON so it satisfies the same schema.",
    "Do not omit required fields, do not add commentary, and keep numeric fields as JSON numbers.",
  ].join(" ");
}

export async function runSynthesisInvocation(
  invocation: SynthesisInvocation,
  runner: PiInvocationRunner = runPiInvocation,
): Promise<SynthesisInvocationResult> {
  const processResult = await runner({
    command: invocation.piCommand,
    args: [
      "--mode",
      "json",
      "--model",
      formatModelRef(invocation.model),
      ...(invocation.thinking ? ["--thinking", invocation.thinking] : []),
      "--tools",
      invocation.allowedTools.join(","),
      "--append-system-prompt",
      invocation.systemPrompt,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      invocation.prompt,
    ],
    cwd: invocation.cwd,
    env: invocation.env,
    timeoutMs: invocation.timeoutMs,
  });

  if (processResult.timedOut) {
    throw new Error(`synthesis subprocess timed out after ${invocation.timeoutMs}ms`);
  }

  const assistantText = processResult.assistantText.trim();

  if (processResult.exitCode === 0 && assistantText) {
    const output = JSON.parse(assistantText) as ConsensusSynthesisOutput;
    return { model: invocation.model, output, rawOutputText: assistantText };
  }

  throw new Error(
    [
      processResult.exitCode !== 0
        ? `synthesis subprocess exited with code ${processResult.exitCode}${processResult.signal ? ` (${processResult.signal})` : ""}`
        : undefined,
      processResult.stderr.trim() || undefined,
      !assistantText ? "synthesis produced no assistant output" : undefined,
    ]
      .filter(Boolean)
      .join(": ") || "synthesis subprocess failed",
  );
}

export function readSynthesisEventLine(line: string): string | undefined {
  const event = parsePiJsonEventLine(line);
  if (!event) {
    return undefined;
  }

  return readAssistantTextFromMessageEndEvent(event);
}

export function validateSynthesisOutput(output: ConsensusSynthesisOutput) {
  if (!output || typeof output !== "object") {
    throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output must be an object.");
  }

  requireString(output.consensusAnswer, "consensusAnswer");
  requirePercent(output.overallAgreementPercent, "overallAgreementPercent");
  requirePercent(output.overallDisagreementPercent, "overallDisagreementPercent");
  requirePercent(output.overallUnclearPercent, "overallUnclearPercent");
  if (output.overallAgreementPercent + output.overallDisagreementPercent + output.overallUnclearPercent !== 100) {
    throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output overallAgreementPercent, overallDisagreementPercent, and overallUnclearPercent must sum to 100.");
  }

  requirePercent(output.confidencePercent, "confidencePercent");
  requireString(output.confidenceLabel, "confidenceLabel");
  requireArray(output.agreedPoints, "agreedPoints");
  requireArray(output.disagreements, "disagreements");
  requireArray(output.participants, "participants");
  requireArray(output.excludedParticipants, "excludedParticipants");

  for (const point of output.agreedPoints) {
    if (!point || typeof point !== "object") {
      throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output agreedPoints entries must be objects.");
    }
    requireString(point.point, "agreedPoints[].point");
    requirePercent(point.supportPercent, "agreedPoints[].supportPercent");
    requireNonNegativeInteger(point.supportingParticipants, "agreedPoints[].supportingParticipants");
    requireNonNegativeInteger(point.totalParticipants, "agreedPoints[].totalParticipants");
  }

  for (const disagreement of output.disagreements) {
    if (!disagreement || typeof disagreement !== "object") {
      throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output disagreements entries must be objects.");
    }
    requireString(disagreement.point, "disagreements[].point");
    requireString(disagreement.summary, "disagreements[].summary");
  }

  for (const participant of output.participants) {
    if (!participant || typeof participant !== "object") {
      throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output participants entries must be objects.");
    }
    requireString(participant.model, "participants[].model");
    requireString(participant.summary, "participants[].summary");
  }

  for (const excluded of output.excludedParticipants) {
    if (!excluded || typeof excluded !== "object") {
      throw new InvalidConsensusSynthesisOutputError("Consensus synthesis output excludedParticipants entries must be objects.");
    }
    requireString(excluded.model, "excludedParticipants[].model");
    requireString(excluded.reason, "excludedParticipants[].reason");
  }
}

function requireString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidConsensusSynthesisOutputError(`Consensus synthesis output field "${fieldName}" must be a non-empty string.`);
  }
}

function requirePercent(value: unknown, fieldName: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new InvalidConsensusSynthesisOutputError(`Consensus synthesis output field "${fieldName}" must be a number between 0 and 100.`);
  }
}

function requireArray(value: unknown, fieldName: string) {
  if (!Array.isArray(value)) {
    throw new InvalidConsensusSynthesisOutputError(`Consensus synthesis output field "${fieldName}" must be an array.`);
  }
}

function requireNonNegativeInteger(value: unknown, fieldName: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidConsensusSynthesisOutputError(`Consensus synthesis output field "${fieldName}" must be a non-negative integer.`);
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

