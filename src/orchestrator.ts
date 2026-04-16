import { formatModelRef, loadConsensusConfig, type Focus, type ResolvedConsensusConfig, type Stance } from "./config.ts";
import {
  filterParticipantOutputs,
  runParticipantInvocation,
  runParticipantPass,
  type ParticipantInvocationExecutor,
} from "./participants.ts";
import { createConsensusExecutionResult } from "./result.ts";
import {
  runConsensusSynthesis,
  runSynthesisInvocation,
  type SynthesisInvocationExecutor,
} from "./synthesis.ts";

export type ConsensusRunRequest = {
  prompt: string;
  overrides?: {
    stance?: Stance;
    focus?: Focus;
  };
};

export type ConsensusRunContext = {
  cwd: string;
  agentDir?: string;
  currentModel?: { provider: string; id: string };
  availableModels: Array<{ provider: string; id: string }>;
};

export type ParticipantProgressStatus = "pending" | "running" | "retrying" | "completed" | "failed" | "excluded";
export type SynthesisProgressStatus =
  | "pending"
  | "running"
  | "retrying"
  | "response-received"
  | "validating"
  | "completed"
  | "degraded"
  | "skipped"
  | "failed";

export type ConsensusRunProgress = {
  stage: "config-validation" | "participant-pass" | "pre-synthesis-gate" | "synthesis" | "failed";
  message: string;
  selectedParticipants: string[];
  synthesisModel?: string;
  participants: Array<{ model: string; status: ParticipantProgressStatus }>;
  synthesis: SynthesisProgressStatus;
  failureMessage?: string;
};

export type ConsensusProgressSink = {
  onProgress?: (event: ConsensusRunProgress) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

export type ConsensusOrchestratorDeps = {
  executeParticipantInvocation?: ParticipantInvocationExecutor;
  executeSynthesisInvocation?: SynthesisInvocationExecutor;
  formatResult?: typeof createConsensusExecutionResult;
};

export type ConsensusRunOutcome = {
  content: [{ type: "text"; text: string }];
  details: ReturnType<typeof createConsensusExecutionResult>["details"];
};

export type ConsensusOrchestrator = {
  execute(
    request: ConsensusRunRequest,
    ctx: ConsensusRunContext,
    progress?: ConsensusProgressSink,
  ): Promise<ConsensusRunOutcome>;
};

type ConsensusProgressState = {
  stage: "config-validation" | "participant-pass" | "pre-synthesis-gate" | "synthesis" | "failed";
  selectedParticipants: string[];
  synthesisModel?: string;
  participants: Map<string, ParticipantProgressStatus>;
  synthesis: SynthesisProgressStatus;
  failureMessage?: string;
};

export function createConsensusOrchestrator(
  deps: ConsensusOrchestratorDeps = {},
): ConsensusOrchestrator {
  const formatResult = deps.formatResult ?? createConsensusExecutionResult;

  return {
    async execute(request, ctx, progress) {
      const state = createConsensusProgressState();
      const emit = (message: string) => {
        progress?.onProgress?.({
          stage: state.stage,
          message,
          selectedParticipants: [...state.selectedParticipants],
          synthesisModel: state.synthesisModel,
          participants: [...state.participants.entries()].map(([model, status]) => ({ model, status })),
          synthesis: state.synthesis,
          failureMessage: state.failureMessage,
        });
      };

      try {
        state.stage = "config-validation";
        emit("Validating consensus config...");

        let config: ResolvedConsensusConfig;
        try {
          config = validateConsensusContext(ctx);
        } catch (error) {
          throw createConsensusStageError("config validation failed", error);
        }

        if (request.overrides?.stance || request.overrides?.focus) {
          config = {
            ...config,
            models: config.models.map((model) => ({
              ...model,
              ...(request.overrides?.stance ? { stance: request.overrides.stance } : {}),
              ...(request.overrides?.focus ? { focus: request.overrides.focus } : {}),
            })),
          };
        }

        state.selectedParticipants = config.models.map(formatModelRef);
        state.synthesisModel = formatModelRef(config.synthesisModel);
        for (const warning of config.warnings) {
          progress?.notify?.(warning, "warning");
        }

        if (request.overrides?.stance || request.overrides?.focus) {
          const overrideParts = [
            request.overrides.stance ? `stance: ${request.overrides.stance}` : "",
            request.overrides.focus ? `focus: ${request.overrides.focus}` : "",
          ].filter(Boolean);
          progress?.notify?.(`Using command-level ${overrideParts.join(", ")} override for this run.`, "info");
        }

        for (const model of config.models) {
          state.participants.set(formatModelRef(model), "pending");
        }

        state.stage = "participant-pass";
        emit("Running participant pass...");

        let participantPass;
        try {
          participantPass = await runParticipantPass(
            {
              prompt: request.prompt,
              cwd: ctx.cwd,
              config,
            },
            createProgressParticipantExecutor(state, emit, deps.executeParticipantInvocation),
          );
        } catch (error) {
          throw createConsensusStageError("participant subprocess failed", error);
        }

        const filteredParticipants = filterParticipantOutputs(participantPass.participants, {
          stoppedEarly: participantPass.stoppedEarly,
          earlyStopReason: participantPass.earlyStopReason,
        });
        syncFilteredParticipantStatuses(state, filteredParticipants.participants);

        state.stage = "pre-synthesis-gate";
        emit(
          filteredParticipants.failureMessage
            ? "Pre-synthesis gate failed; skipping synthesis."
            : `Pre-synthesis gate passed with ${filteredParticipants.usable.length} usable participants; starting synthesis.`,
        );

        let synthesis;
        let synthesisStatus: "full" | "repaired" | "degraded" | undefined;
        if (filteredParticipants.failureMessage) {
          state.synthesis = "skipped";
          emit("Skipping synthesis because the minimum usable participant count was not reached.");
        } else {
          try {
            synthesis = await runConsensusSynthesis(
              {
                prompt: request.prompt,
                cwd: ctx.cwd,
                config,
                usableParticipants: filteredParticipants.usable,
                excludedParticipants: [...filteredParticipants.excluded, ...filteredParticipants.failed],
              },
              createProgressSynthesisExecutor(state, emit, deps.executeSynthesisInvocation),
              {
                onResponseReceived: () => {
                  state.synthesis = "response-received";
                  emit("Synthesis response received.");
                },
                onValidationStarted: () => {
                  state.synthesis = "validating";
                  emit("Validating synthesis output...");
                },
                onRetry: (attempt, maxAttempts) => {
                  state.synthesis = "retrying";
                  emit(`Retrying synthesis (attempt ${attempt}/${maxAttempts})...`);
                },
                onDegraded: () => {
                  state.synthesis = "degraded";
                  emit("Synthesis completed (degraded mode).");
                },
              },
            );
            synthesisStatus = synthesis.status;
            if (synthesis.status !== "degraded") {
              state.synthesis = "completed";
              emit("Synthesis completed.");
            }
          } catch (error) {
            throw createConsensusStageError("synthesis subprocess failed", error);
          }
        }

        const result = formatResult(
          request.prompt,
          toConsensusSummary(config),
          filteredParticipants.participants.map(toParticipantSummary),
          filteredParticipants.failureMessage,
          synthesis?.output,
          synthesisStatus,
          synthesis?.rawOutputText,
        );

        if (!filteredParticipants.failureMessage) {
          progress?.notify?.("pi-consensus participant pass and synthesis completed.", "info");
        }

        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      } catch (error) {
        const stageError = normalizeConsensusWorkflowError(error);
        state.stage = "failed";
        state.failureMessage = stageError.message;
        if (stageError.stage === "synthesis output validation failed" || stageError.stage === "synthesis subprocess failed") {
          state.synthesis = "failed";
        }
        emit(stageError.message);
        progress?.notify?.(stageError.message, "error");
        throw new Error(stageError.message);
      }
    },
  };
}

function createConsensusProgressState(): ConsensusProgressState {
  return {
    stage: "config-validation",
    selectedParticipants: [],
    participants: new Map(),
    synthesis: "pending",
  };
}

function validateConsensusContext(ctx: ConsensusRunContext) {
  return loadConsensusConfig({
    cwd: ctx.cwd,
    agentDir: ctx.agentDir,
    availableModels: ctx.availableModels,
    currentModel: ctx.currentModel,
  });
}

function createProgressParticipantExecutor(
  progress: ConsensusProgressState,
  emit: (message: string) => void,
  executor?: ParticipantInvocationExecutor,
): ParticipantInvocationExecutor {
  const attemptsByModel = new Map<string, number>();

  return async (invocation) => {
    const model = formatModelRef(invocation.model);
    const attempt = (attemptsByModel.get(model) ?? 0) + 1;
    attemptsByModel.set(model, attempt);

    if (attempt > 1) {
      progress.participants.set(model, "retrying");
      emit(`Retrying participant ${model} (attempt ${attempt})...`);
    } else {
      progress.participants.set(model, "running");
      emit(`Running participant pass... ${model}`);
    }

    const result = await (executor ?? runParticipantInvocation)(invocation);

    progress.participants.set(model, result.status === "failed" ? "failed" : "completed");
    emit(`Participant finished: ${model}`);
    return result;
  };
}

function createProgressSynthesisExecutor(
  progress: ConsensusProgressState,
  emit: (message: string) => void,
  executor?: SynthesisInvocationExecutor,
): SynthesisInvocationExecutor {
  return async (invocation) => {
    progress.stage = "synthesis";
    progress.synthesis = "running";
    emit("Running synthesis...");
    return (executor ?? runSynthesisInvocation)(invocation);
  };
}

function syncFilteredParticipantStatuses(
  progress: ConsensusProgressState,
  participants: Array<{ model: { provider: string; id: string }; status: "usable" | "usable-with-warning" | "excluded" | "failed" }>,
) {
  for (const participant of participants) {
    progress.participants.set(
      formatModelRef(participant.model),
      participant.status === "usable" || participant.status === "usable-with-warning" ? "completed" : participant.status,
    );
  }
}

function toConsensusSummary(config: ResolvedConsensusConfig) {
  return {
    configPath: config.configPath,
    participants: config.models.map(formatModelRef),
    synthesisModel: formatModelRef(config.synthesisModel),
    warnings: config.warnings,
  };
}

function toParticipantSummary(participant: {
  model: { provider: string; id: string; stance?: Stance; focus?: Focus };
  status: "usable" | "usable-with-warning" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  warningReasons?: string[];
  inspectedRepo: boolean;
  toolNamesUsed: string[];
  retried?: boolean;
  retryReason?: string;
}) {
  return {
    model: formatModelRef(participant.model),
    status: participant.status,
    output: participant.output,
    failureReason: participant.failureReason,
    exclusionReason: participant.exclusionReason,
    warningReasons: participant.warningReasons,
    inspectedRepo: participant.inspectedRepo,
    toolNamesUsed: participant.toolNamesUsed,
    stance: participant.model.stance,
    focus: participant.model.focus,
    retried: participant.retried,
    retryReason: participant.retryReason,
  };
}

function createConsensusStageError(stage: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${capitalize(stage)}: ${reason}`);
  wrapped.name = "ConsensusWorkflowStageError";
  Object.assign(wrapped, { consensusStage: stage });
  return wrapped;
}

function normalizeConsensusWorkflowError(error: unknown) {
  if (error && typeof error === "object" && "consensusStage" in error && typeof (error as { consensusStage?: unknown }).consensusStage === "string") {
    return {
      stage: (error as { consensusStage: string }).consensusStage,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    stage: "workflow failed",
    message,
  };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
