type ConsensusExecutionSummary = {
  configPath: string;
  participants: string[];
  synthesisModel: string;
  warnings: string[];
};

type ParticipantExecutionSummary = {
  model: string;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
};

export type ConsensusExecutionResult = {
  text: string;
  details: {
    status: "participant-pass-complete";
    prompt: string;
    readOnly: true;
    config: ConsensusExecutionSummary;
    participants: ParticipantExecutionSummary[];
    nextSteps: string[];
  };
};

export function createConsensusExecutionResult(
  prompt: string,
  config: ConsensusExecutionSummary,
  participants: ParticipantExecutionSummary[],
): ConsensusExecutionResult {
  const text = [
    "pi-consensus participant pass completed.",
    `Prompt: ${prompt}`,
    `Config: ${config.configPath}`,
    `Participants: ${config.participants.join(", ")}`,
    `Synthesis model: ${config.synthesisModel}`,
    `Warnings: ${config.warnings.length === 0 ? "none" : config.warnings.join(" | ")}`,
    "Participant results:",
    ...participants.flatMap((participant) => renderParticipantSummary(participant)),
    "Status: first-pass participant outputs collected; synthesis not implemented yet.",
    "Read-only posture: no edit/write behavior is exposed.",
    "Next steps: apply usability filtering, synthesize a consensus, and persist the final tool result.",
  ].join("\n");

  return {
    text,
    details: {
      status: "participant-pass-complete",
      prompt,
      readOnly: true,
      config,
      participants,
      nextSteps: [
        "Filter unusable participant outputs.",
        "Add synthesis and final result rendering.",
        "Persist results via the pi-native tool-result path.",
      ],
    },
  };
}

function renderParticipantSummary(participant: ParticipantExecutionSummary) {
  const headline = `- ${participant.model} — ${participant.status}`;

  if (participant.status === "failed") {
    return [
      headline,
      `  Failure: ${participant.failureReason ?? "unknown error"}`,
      `  Repo inspection: ${participant.inspectedRepo ? "yes" : "no"}`,
      `  Tools used: ${participant.toolNamesUsed.length === 0 ? "none" : participant.toolNamesUsed.join(", ")}`,
    ];
  }

  return [
    headline,
    `  Repo inspection: ${participant.inspectedRepo ? "yes" : "no"}`,
    `  Tools used: ${participant.toolNamesUsed.length === 0 ? "none" : participant.toolNamesUsed.join(", ")}`,
    `  Output: ${participant.output ?? ""}`,
  ];
}
