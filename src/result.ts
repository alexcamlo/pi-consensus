import type { ConsensusSynthesisOutput } from "./synthesis.ts";

type ConsensusExecutionSummary = {
  configPath: string;
  participants: string[];
  synthesisModel: string;
  warnings: string[];
};

type ParticipantExecutionSummary = {
  model: string;
  status: "usable" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
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
    nextSteps: string[];
  };
};

export function createConsensusExecutionResult(
  prompt: string,
  config: ConsensusExecutionSummary,
  participants: ParticipantExecutionSummary[],
  failureMessage?: string,
  synthesis?: ConsensusSynthesisOutput,
): ConsensusExecutionResult {
  const usableParticipantCount = participants.filter((participant) => participant.status === "usable").length;
  const excludedParticipantCount = participants.filter((participant) => participant.status === "excluded").length;
  const failedParticipantCount = participants.filter((participant) => participant.status === "failed").length;
  const excludedParticipants = participants.filter((participant) => participant.status !== "usable");
  const participantSummaries = synthesis?.participants ?? participants.map((participant) => ({ model: participant.model, summary: participant.status }));
  const text = [
    "# Consensus",
    "",
    "## Prompt",
    prompt,
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
    "",
    "## Participants",
    ...participantSummaries.map((participant) => `- ${participant.model} — ${participant.summary}`),
    "",
    "## Excluded",
    ...(synthesis?.excludedParticipants.length
      ? synthesis.excludedParticipants.map((participant) => `- ${participant.model} — ${participant.reason}`)
      : excludedParticipants.length
        ? excludedParticipants.map((participant) => `- ${participant.model} — ${participant.status === "failed" ? (participant.failureReason ?? "failed") : (participant.exclusionReason ?? "excluded")}`)
        : ["- None"]),
    "",
    "## Metadata",
    `- Config: ${config.configPath}`,
    `- Requested participants: ${config.participants.join(", ")}`,
    `- Synthesis model: ${config.synthesisModel}`,
    `- Warnings: ${config.warnings.length === 0 ? "none" : config.warnings.join(" | ")}`,
    `- Read-only posture: enabled`,
    "",
    "## Debug participant outputs",
    ...participants.flatMap((participant) => renderParticipantSummary(participant)),
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
      nextSteps: failureMessage
        ? ["Retry with a prompt that yields at least 2 usable participant outputs.", "Add synthesis once usable outputs are available."]
        : synthesis
          ? ["Render the structured consensus result for users.", "Persist results via the pi-native tool-result path."]
          : ["Synthesize a consensus from usable participant outputs.", "Persist results via the pi-native tool-result path."],
    },
  };
}

function renderParticipantSummary(participant: ParticipantExecutionSummary) {
  const headline = `### ${participant.model} — ${participant.status}`;

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
    `- Repo inspection: ${participant.inspectedRepo ? "yes" : "no"}`,
    `- Tools used: ${participant.toolNamesUsed.length === 0 ? "none" : participant.toolNamesUsed.join(", ")}`,
    `- Output: ${participant.output ?? ""}`,
    "",
  ];
}
