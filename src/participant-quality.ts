import type { ConsensusModelRef } from "./config.ts";

export type ParticipantQualityInput = {
  model: ConsensusModelRef;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
  retried?: boolean;
  retryReason?: string;
};

export type ParticipantQualityDiagnosticCode =
  | "participant-execution-failed"
  | "empty-response"
  | "refusal-only-response"
  | "too-vague"
  | "non-evaluative-response"
  | "missing-structured-sections";

export type ParticipantQualityDiagnostic = {
  code: ParticipantQualityDiagnosticCode;
  message: string;
  severity: "warning" | "error";
};

export type ParticipantQualityClassification = {
  model: ConsensusModelRef;
  status: "usable" | "usable-with-warning" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  warningReasons?: string[];
  surfacedDiagnostics: ParticipantQualityDiagnostic[];
  inspectedRepo: boolean;
  toolNamesUsed: string[];
  retried?: boolean;
  retryReason?: string;
};

// Patterns that indicate a response is asking for more context instead of evaluating
const NON_EVALUATIVE_PATTERNS = [
  /need more information/i,
  /need(s)? more context/i,
  /cannot evaluate without more context/i,
  /can't evaluate without more context/i,
  /insufficient information/i,
  /insufficient context/i,
  /would need to inspect more of the codebase/i,
  /would need to see more of the codebase/i,
  /depends on details not provided/i,
  /missing (the )?necessary (details|context|information)/i,
  /unable to (provide a recommendation|make a recommendation|evaluate)/i,
  /cannot (provide a recommendation|make a recommendation|evaluate) without/i,
  /more information (would be|is) needed/i,
  /request for more information/i,
  /requires more context/i,
  /not enough (information|context|details)/i,
] as const;

export function looksLikeNonEvaluativeResponse(output: string): boolean {
  const normalized = output.replace(/\s+/g, " ").trim();
  return NON_EVALUATIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isUsableParticipantQualityStatus(status: ParticipantQualityClassification["status"]): boolean {
  return status === "usable" || status === "usable-with-warning";
}

export function classifyParticipantQuality(participant: ParticipantQualityInput): ParticipantQualityClassification {
  if (participant.status === "failed") {
    const reason = participant.failureReason ?? "participant subprocess failed";
    return {
      ...participant,
      status: "failed",
      failureReason: reason,
      surfacedDiagnostics: [
        {
          code: "participant-execution-failed",
          message: reason,
          severity: "error",
        },
      ],
    };
  }

  const output = participant.output?.trim() ?? "";
  if (!output) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "empty response",
      surfacedDiagnostics: [
        {
          code: "empty-response",
          message: "empty response",
          severity: "error",
        },
      ],
    };
  }

  if (looksLikeRefusalOnly(output)) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "refusal-only response",
      surfacedDiagnostics: [
        {
          code: "refusal-only-response",
          message: "refusal-only response",
          severity: "error",
        },
      ],
    };
  }

  if (looksTooVague(output)) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "response was too vague to use for consensus",
      surfacedDiagnostics: [
        {
          code: "too-vague",
          message: "response was too vague to use for consensus",
          severity: "error",
        },
      ],
    };
  }

  if (looksLikeNonEvaluativeResponse(output)) {
    const reason = participant.retried
      ? "non-evaluative response after retry"
      : "non-evaluative response asking for more context";

    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: reason,
      surfacedDiagnostics: [
        {
          code: "non-evaluative-response",
          message: reason,
          severity: "error",
        },
      ],
    };
  }

  const warningReasons = getBorderlineWarningReasons(output);
  if (warningReasons.length > 0) {
    return {
      ...participant,
      status: "usable-with-warning",
      output,
      warningReasons,
      surfacedDiagnostics: warningReasons.map((reason) => ({
        code: "missing-structured-sections",
        message: reason,
        severity: "warning" as const,
      })),
    };
  }

  return {
    ...participant,
    status: "usable",
    output,
    surfacedDiagnostics: [],
  };
}

function looksLikeRefusalOnly(output: string) {
  const normalized = output.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length > 220) {
    return false;
  }

  return [
    /^(i('|’)m sorry[, ]+but )?i can('|’)t help with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i cannot help with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i can('|’)t assist with that[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i cannot comply with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i don('|’)t have enough information to answer[.!]?$/,
  ].some((pattern) => pattern.test(normalized));
}

function looksTooVague(output: string) {
  const normalized = output.replace(/\s+/g, " ").trim();
  if (normalized.length >= 40) {
    return false;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount <= 6;
}

function getBorderlineWarningReasons(output: string) {
  const missingSections = [
    { label: "why", pattern: /\bwhy\s*:/i },
    { label: "risks/tradeoffs", pattern: /\brisks?\s*\/\s*tradeoffs?\s*:/i },
    { label: "confidence", pattern: /\bconfidence\s*:/i },
    { label: "repo evidence", pattern: /\brepo evidence\s*:/i },
  ].filter((section) => !section.pattern.test(output));

  if (missingSections.length === 0) {
    return [];
  }

  return [`missing structured sections: ${missingSections.map((section) => section.label).join(", ")}`];
}
