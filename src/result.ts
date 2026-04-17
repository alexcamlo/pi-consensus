import type { Stance, Focus } from "./config.ts";
import type { ConsensusSynthesisOutput } from "./synthesis.ts";

type ConsensusExecutionSummary = {
  configPath: string;
  participants: string[];
  synthesisModel: string;
  warnings: string[];
};

type ParticipantExecutionSummary = {
  model: string;
  status: "usable" | "usable-with-warning" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  warningReasons?: string[];
  surfacedDiagnostics?: Array<{ code: string; message: string; severity: "warning" | "error" }>;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
  stance?: Stance;
  focus?: Focus;
};

export type ConsensusExecutionResult = {
  text: string;
  details: {
    status: "synthesis-complete" | "participant-pass-insufficient-usable";
    prompt: string;
    readOnly: true;
    config: ConsensusExecutionSummary;
    participants: ParticipantExecutionSummary[];
    usableParticipantCount: number;
    excludedParticipantCount: number;
    failedParticipantCount: number;
    failureMessage?: string;
    synthesis?: ConsensusSynthesisOutput;
    synthesisStatus?: "complete" | "degraded";
    rawSynthesisOutputText?: string;
    nextSteps: string[];
  };
};

export function createConsensusExecutionResult(
  prompt: string,
  config: ConsensusExecutionSummary,
  participants: ParticipantExecutionSummary[],
  failureMessage?: string,
  synthesis?: ConsensusSynthesisOutput,
  synthesisStatus?: "complete" | "degraded",
  rawSynthesisOutputText?: string,
): ConsensusExecutionResult {
  const usableParticipantCount = participants.filter(
    (participant) => participant.status === "usable" || participant.status === "usable-with-warning",
  ).length;
  const excludedParticipantCount = participants.filter((participant) => participant.status === "excluded").length;
  const failedParticipantCount = participants.filter((participant) => participant.status === "failed").length;
  const excludedParticipants = participants.filter(
    (participant) => participant.status === "excluded" || participant.status === "failed",
  );
  const participantSummaries = synthesis?.participants ?? participants.map((participant) => ({ model: participant.model, summary: participant.status }));
  const text = [
    "# Consensus",
    "",
    "## Prompt",
    prompt,
    "",
    "## Participants",
    ...participantSummaries.map((summary) => {
      const participant = participants.find((p) => p.model === summary.model);
      const framing = [participant?.stance && `stance: ${participant.stance}`, participant?.focus && `focus: ${participant.focus}`].filter(Boolean).join(", ");
      const framingSuffix = framing ? ` (${framing})` : "";
      return `- ${summary.model}${framingSuffix} — ${summary.summary}`;
    }),
    "",
    "## Metadata",
    `- Config: ${config.configPath}`,
    `- Requested participants: ${config.participants.join(", ")}`,
    `- Synthesis model: ${config.synthesisModel}`,
    synthesisStatus ? `- Synthesis status: ${synthesisStatus}${synthesisStatus === "degraded" ? " (result may be less structured)" : ""}` : "",
    `- Warnings: ${config.warnings.length === 0 ? "none" : config.warnings.join(" | ")}`,
    `- Read-only posture: enabled`,
    "",
    "## Debug participant outputs",
    ...participants.flatMap((participant) => renderParticipantSummary(participant)),
    "## Debug synthesis output",
    ...(rawSynthesisOutputText ? ["```", rawSynthesisOutputText, "```", ""] : ["- None", ""]),
    "## Excluded",
    ...(synthesis?.excludedParticipants.length
      ? synthesis.excludedParticipants.map((participant) => `- ${participant.model} — ${participant.reason}`)
      : excludedParticipants.length
        ? excludedParticipants.map((participant) => `- ${participant.model} — ${participant.status === "failed" ? (participant.failureReason ?? "failed") : (participant.exclusionReason ?? "excluded")}`)
        : ["- None"]),
    "",
    ...(synthesis
      ? ["## Answer", synthesis.consensusAnswer, ""]
      : ["## Answer", failureMessage ?? "Consensus synthesis was skipped.", ""]),
    "## Overall",
    ...(synthesis
      ? [
          `- Agreement: ${synthesis.overallAgreementPercent}%`,
          `- Disagreement: ${synthesis.overallDisagreementPercent}%`,
          `- Unclear: ${synthesis.overallUnclearPercent}%`,
          `- Confidence: ${synthesis.confidencePercent}% (${synthesis.confidenceLabel})`,
        ]
      : [
          `- Usable participants: ${usableParticipantCount}`,
          `- Excluded participants: ${excludedParticipantCount}`,
          `- Failed participants: ${failedParticipantCount}`,
        ]),
    "",
    "## Agreed points",
    ...(synthesis?.agreedPoints.length
      ? synthesis.agreedPoints.map(
          (point) => `- ${point.point} — ${point.supportPercent}% (${point.supportingParticipants}/${point.totalParticipants})`,
        )
      : ["- None yet"]),
    "",
    "## Disagreements",
    ...(synthesis?.disagreements.length
      ? synthesis.disagreements.map((disagreement) => `- ${disagreement.point} — ${disagreement.summary}`)
      : [failureMessage ? `- ${failureMessage}` : "- None noted"]),
  ].join("\n");

  return {
    text,
    details: {
      status: failureMessage ? "participant-pass-insufficient-usable" : "synthesis-complete",
      prompt,
      readOnly: true,
      config,
      participants,
      usableParticipantCount,
      excludedParticipantCount,
      failedParticipantCount,
      failureMessage,
      synthesis,
      synthesisStatus,
      rawSynthesisOutputText,
      nextSteps: failureMessage
        ? ["Retry with a prompt that yields at least 2 usable participant outputs.", "Add synthesis once usable outputs are available."]
        : synthesis
          ? ["Inspect debug participant outputs when you need to audit the consensus.", "Re-run /consensus with a refined prompt if you want a narrower comparison."]
          : ["Synthesize a consensus from usable participant outputs.", "Inspect debug participant outputs before re-running if needed."],
    },
  };
}

function renderParticipantSummary(participant: ParticipantExecutionSummary) {
  const framing = [participant.stance && `stance: ${participant.stance}`, participant.focus && `focus: ${participant.focus}`].filter(Boolean).join(", ");
  const headline = `### ${participant.model} — ${participant.status}${framing ? ` (${framing})` : ""}`;

  if (participant.status === "failed") {
    return [
      headline,
      `- Failure: ${participant.failureReason ?? "unknown error"}`,
      `- Repo inspection: ${participant.inspectedRepo ? "yes" : "no"}`,
      `- Tools used: ${participant.toolNamesUsed.length === 0 ? "none" : participant.toolNamesUsed.join(", ")}`,
      "",
    ];
  }

  return [
    headline,
    ...(participant.status === "excluded" ? [`- Reason: ${participant.exclusionReason ?? "excluded from consensus"}`] : []),
    ...(participant.status === "usable-with-warning"
      ? [`- Warnings: ${participant.warningReasons?.length ? participant.warningReasons.join(" | ") : "borderline but still usable"}`]
      : []),
    ...(participant.surfacedDiagnostics?.length
      ? [
          `- Diagnostics: ${participant.surfacedDiagnostics
            .map((diagnostic) => `${diagnostic.severity}:${diagnostic.code} (${diagnostic.message})`)
            .join(" | ")}`,
        ]
      : []),
    `- Repo inspection: ${participant.inspectedRepo ? "yes" : "no"}`,
    `- Tools used: ${participant.toolNamesUsed.length === 0 ? "none" : participant.toolNamesUsed.join(", ")}`,
    `- Output: ${participant.output ?? ""}`,
    "",
  ];
}
