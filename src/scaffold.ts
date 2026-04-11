export type ConsensusScaffoldResult = {
  text: string;
  details: {
    status: "scaffolded";
    prompt: string;
    readOnly: true;
    nextSteps: string[];
  };
};

export function createConsensusScaffoldResult(prompt: string): ConsensusScaffoldResult {
  return {
    text: [
      "pi-consensus scaffold is installed.",
      `Prompt: ${prompt}`,
      "Status: placeholder execution path only.",
      "Read-only posture: no edit/write behavior is exposed.",
      "Next steps: implement config loading, participant subprocesses, and synthesis.",
    ].join("\n"),
    details: {
      status: "scaffolded",
      prompt,
      readOnly: true,
      nextSteps: [
        "Implement config loading.",
        "Run participant subprocesses in parallel.",
        "Add synthesis and rendering.",
      ],
    },
  };
}
