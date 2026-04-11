export type ConsensusModelRef = {
  provider: string;
  id: string;
};

export type ConsensusConfig = {
  models: ConsensusModelRef[];
  synthesisModel?: ConsensusModelRef;
  participantThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  synthesisThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  participantTimeoutMs?: number;
  synthesisTimeoutMs?: number;
};
