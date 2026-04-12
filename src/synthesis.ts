import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { formatModelRef, type ConsensusModelRef, type ResolvedConsensusConfig } from "./config.ts";
import type { ExcludedParticipantResult, FailedParticipantResult, UsableParticipantResult } from "./participants.ts";

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

export type SynthesisExecutionResult = {
  model: ConsensusModelRef;
  output: ConsensusSynthesisOutput;
};

export type SynthesisInvocationExecutor = (invocation: SynthesisInvocation) => Promise<SynthesisExecutionResult>;

export class InvalidConsensusSynthesisOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConsensusSynthesisOutputError";
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

  const result = await executeSynthesisInvocation(invocation);
  hooks.onResponseReceived?.();
  hooks.onValidationStarted?.();
  validateSynthesisOutput(result.output);
  return result;
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
    "confidencePercent must be a number from 0 to 100 and confidenceLabel must be a short string.",
    "Each agreedPoints entry must include point, supportPercent, supportingParticipants, totalParticipants.",
    "Each disagreements entry must include point and summary.",
    "Each participants entry must include model and summary.",
    "Each excludedParticipants entry must include model and reason.",
    ...excludedLines,
  ].join(" ");
}

export async function runSynthesisInvocation(invocation: SynthesisInvocation): Promise<SynthesisExecutionResult> {
  return new Promise((resolve, reject) => {
    const command = invocation.piCommand ?? "pi";
    const args = [
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
    ];

    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastAssistantText = "";
    let stderr = "";
    let timedOut = false;

    const timeout = invocation.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, invocation.timeoutMs)
      : undefined;

    const stdout = child.stdout;
    if (stdout) {
      const reader = createInterface({ input: stdout, crlfDelay: Infinity });
      reader.on("line", (line) => {
        const event = parseJsonLine(line);
        if (!event || typeof event !== "object") {
          return;
        }

        if (event.type === "message_end") {
          const assistantText = extractAssistantText(event.message);
          if (assistantText) {
            lastAssistantText = assistantText;
          }
        }
      });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`synthesis subprocess timed out after ${invocation.timeoutMs}ms`));
        return;
      }

      if (code === 0 && lastAssistantText.trim()) {
        try {
          const output = JSON.parse(lastAssistantText) as ConsensusSynthesisOutput;
          validateSynthesisOutput(output);
          resolve({ model: invocation.model, output });
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }

      reject(
        new Error(
          [
            code !== 0 ? `synthesis subprocess exited with code ${code}${signal ? ` (${signal})` : ""}` : undefined,
            stderr.trim() || undefined,
            !lastAssistantText.trim() ? "synthesis produced no assistant output" : undefined,
          ]
            .filter(Boolean)
            .join(": ") || "synthesis subprocess failed",
        ),
      );
    });
  });
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

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAssistantText(message: unknown) {
  if (!message || typeof message !== "object") {
    return "";
  }

  const role = Reflect.get(message, "role");
  if (role !== "assistant") {
    return "";
  }

  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      const type = Reflect.get(block, "type");
      if (type !== "text") {
        return "";
      }

      const text = Reflect.get(block, "text");
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}
