export type ConsensusScaffoldSummary = {
  configPath: string;
  participants: string[];
  synthesisModel: string;
  warnings: string[];
};

export type ConsensusScaffoldResult = {
  text: string;
  details: {
    status: "scaffolded";
    prompt: string;
    readOnly: true;
    config?: ConsensusScaffoldSummary;
    nextSteps: string[];
  };
};

export function createConsensusScaffoldResult(
  prompt: string,
  config?: ConsensusScaffoldSummary,
): ConsensusScaffoldResult {
  const text = [
    "pi-consensus scaffold is installed.",
    `Prompt: ${prompt}`,
    ...(config
      ? [
          `Config: ${config.configPath}`,
          `Participants: ${config.participants.join(", ")}`,
          `Synthesis model: ${config.synthesisModel}`,
          `Warnings: ${config.warnings.length === 0 ? "none" : config.warnings.join(" | ")}`,
        ]
      : []),
    "Status: placeholder execution path only.",
    "Read-only posture: no edit/write behavior is exposed.",
    "Next steps: implement participant subprocesses and synthesis execution.",
  ].join("\n");

  return {
    text,
    details: {
      status: "scaffolded",
      prompt,
      readOnly: true,
      config,
      nextSteps: [
        "Implement participant subprocesses in parallel.",
        "Add synthesis and rendering.",
        "Persist results via the pi-native tool-result path.",
      ],
    },
  };
}
