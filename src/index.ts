import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { formatModelRef, loadConsensusConfig, type ResolvedConsensusConfig } from "./config.ts";
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

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";
const COMMAND_MESSAGE_TYPE = "consensus-command";

export default function consensusExtension(
  pi: ExtensionAPI,
  dependencies: {
    executeParticipantInvocation?: ParticipantInvocationExecutor;
    executeSynthesisInvocation?: SynthesisInvocationExecutor;
  } = {},
) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      ctx.ui.setStatus("pi-consensus", "pi-consensus loaded");
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Consensus",
    description: "Run a multi-model consensus workflow for a prompt.",
    promptSnippet: "Run a multi-model consensus workflow when the user explicitly asks for consensus.",
    promptGuidelines: [
      "Use this tool only for explicit consensus requests; do not replace normal pi behavior.",
      "Treat this repo as read-only.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The user prompt to evaluate across multiple models." }),
      stance: Type.Optional(Type.String({ description: "Override stance for all participants: for, against, or neutral." })),
      focus: Type.Optional(Type.String({ description: "Override focus for all participants: security, performance, maintainability, implementation speed, or user value." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeConsensusWorkflow(params.prompt, ctx, dependencies, {
        stance: params.stance as "for" | "against" | "neutral" | undefined,
        focus: params.focus as "security" | "performance" | "maintainability" | "implementation speed" | "user value" | undefined,
      });
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Run the pi-consensus workflow for a prompt. Optional: --stance for|against|neutral --focus security|performance|maintainability|implementation speed|user value",
    handler: async (args, ctx) => {
      const parsed = parseConsensusCommandArgs(args.trim());

      if (parsed.error) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      if (!parsed.prompt) {
        ctx.ui.notify("Usage: /consensus [--stance for|against|neutral] [--focus security|performance|maintainability|\"implementation speed\"|\"user value\"] <prompt>", "warning");
        return;
      }

      const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" as const, triggerTurn: true } : { triggerTurn: true };
      pi.sendMessage(
        {
          customType: COMMAND_MESSAGE_TYPE,
          content: createConsensusRelayInstruction(parsed.prompt, parsed.stance, parsed.focus),
          details: { prompt: parsed.prompt, stance: parsed.stance, focus: parsed.focus },
          display: false,
        },
        options,
      );

      if (ctx.isIdle?.() === false) {
        ctx.ui.notify("Queued /consensus as a follow-up tool run.", "info");
      }
    },
  });
}

async function executeConsensusWorkflow(
  prompt: string,
  ctx: {
    cwd?: string;
    agentDir?: string;
    hasUI?: boolean;
    modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string }> };
    model?: { provider: string; id: string };
    ui: {
      notify: (message: string, level?: "error" | "info" | "warning") => void;
      setStatus?: (key: string, status?: string) => void;
      setWidget?: (key: string, widget?: string[]) => void;
    };
  },
  dependencies: {
    executeParticipantInvocation?: ParticipantInvocationExecutor;
    executeSynthesisInvocation?: SynthesisInvocationExecutor;
  },
  overrides?: {
    stance?: "for" | "against" | "neutral";
    focus?: "security" | "performance" | "maintainability" | "implementation speed" | "user value";
  },
) {
  const progress = createConsensusProgressState();

  try {
    progress.stage = "config-validation";
    updateConsensusProgress(ctx, progress, "Validating consensus config...");

    let config: ResolvedConsensusConfig;
    try {
      config = validateConsensusContext(ctx);
    } catch (error) {
      throw createConsensusStageError("config validation failed", error);
    }

    // Apply command-level overrides to all participant models
    if (overrides?.stance || overrides?.focus) {
      config = {
        ...config,
        models: config.models.map((model) => ({
          ...model,
          ...(overrides.stance ? { stance: overrides.stance } : {}),
          ...(overrides.focus ? { focus: overrides.focus } : {}),
        })),
      };
    }

    progress.selectedParticipants = config.models.map(formatModelRef);
    progress.synthesisModel = formatModelRef(config.synthesisModel);
    for (const warning of config.warnings) {
      ctx.ui.notify(warning, "warning");
    }

    // Notify about command-level overrides
    if (overrides?.stance || overrides?.focus) {
      const overrideParts = [
        overrides.stance ? `stance: ${overrides.stance}` : "",
        overrides.focus ? `focus: ${overrides.focus}` : "",
      ].filter(Boolean);
      ctx.ui.notify(`Using command-level ${overrideParts.join(", ")} override for this run.`, "info");
    }

    for (const model of config.models) {
      progress.participants.set(formatModelRef(model), "pending");
    }

    progress.stage = "participant-pass";
    updateConsensusProgress(ctx, progress, "Running participant pass...");

    let participantPass;
    try {
      participantPass = await runParticipantPass(
        {
          prompt,
          cwd: ctx.cwd ?? process.cwd(),
          config,
        },
        createProgressParticipantExecutor(progress, ctx, dependencies.executeParticipantInvocation),
      );
    } catch (error) {
      throw createConsensusStageError("participant subprocess failed", error);
    }

    const filteredParticipants = filterParticipantOutputs(participantPass.participants, {
      stoppedEarly: participantPass.stoppedEarly,
      earlyStopReason: participantPass.earlyStopReason,
    });
    syncFilteredParticipantStatuses(progress, filteredParticipants.participants);

    progress.stage = "pre-synthesis-gate";
    updateConsensusProgress(
      ctx,
      progress,
      filteredParticipants.failureMessage
        ? "Pre-synthesis gate failed; skipping synthesis."
        : `Pre-synthesis gate passed with ${filteredParticipants.usable.length} usable participants; starting synthesis.`,
    );

    let synthesis;
    let synthesisStatus: "full" | "repaired" | "degraded" | undefined;
    if (filteredParticipants.failureMessage) {
      progress.synthesis = "skipped";
      updateConsensusProgress(ctx, progress, "Skipping synthesis because the minimum usable participant count was not reached.");
    } else {
      try {
        synthesis = await runConsensusSynthesis(
          {
            prompt,
            cwd: ctx.cwd ?? process.cwd(),
            config,
            usableParticipants: filteredParticipants.usable,
            excludedParticipants: [...filteredParticipants.excluded, ...filteredParticipants.failed],
          },
          createProgressSynthesisExecutor(progress, ctx, dependencies.executeSynthesisInvocation),
          {
            onResponseReceived: () => {
              progress.synthesis = "response-received";
              updateConsensusProgress(ctx, progress, "Synthesis response received.");
            },
            onValidationStarted: () => {
              progress.synthesis = "validating";
              updateConsensusProgress(ctx, progress, "Validating synthesis output...");
            },
            onDegraded: () => {
              progress.synthesis = "completed";
              updateConsensusProgress(ctx, progress, "Synthesis completed (degraded mode).");
            },
          },
        );
        synthesisStatus = synthesis.status;
        if (synthesis.status !== "degraded") {
          progress.synthesis = "completed";
          updateConsensusProgress(ctx, progress, "Synthesis completed.");
        }
      } catch (error) {
        throw createConsensusStageError("synthesis subprocess failed", error);
      }
    }

    const result = createConsensusExecutionResult(
      prompt,
      toConsensusSummary(config),
      filteredParticipants.participants.map(toParticipantSummary),
      filteredParticipants.failureMessage,
      synthesis?.output,
      synthesisStatus,
    );

    if (!filteredParticipants.failureMessage) {
      ctx.ui.notify("pi-consensus participant pass and synthesis completed.", "info");
    }

    return {
      content: [{ type: "text" as const, text: result.text }],
      details: result.details,
    };
  } catch (error) {
    const stageError = normalizeConsensusWorkflowError(error);
    progress.stage = "failed";
    progress.failureMessage = stageError.message;
    if (stageError.stage === "synthesis output validation failed" || stageError.stage === "synthesis subprocess failed") {
      progress.synthesis = "failed";
    }
    updateConsensusProgress(ctx, progress, stageError.message);
    ctx.ui.notify(stageError.message, "error");
    throw new Error(stageError.message);
  } finally {
    clearConsensusProgress(ctx);
  }
}

function createConsensusRelayInstruction(
  prompt: string,
  stance?: "for" | "against" | "neutral",
  focus?: "security" | "performance" | "maintainability" | "implementation speed" | "user value",
) {
  const args: { prompt: string; stance?: string; focus?: string } = { prompt };
  if (stance) args.stance = stance;
  if (focus) args.focus = focus;

  return [
    "Call the consensus tool immediately.",
    "Your entire response must be exactly one consensus tool call.",
    "Do not answer from your own knowledge.",
    "Do not emit assistant prose, summaries, or follow-up text before or after the tool result.",
    "After the tool result is returned, stop.",
    "Use this exact tool argument JSON:",
    JSON.stringify(args),
  ].join("\n\n");
}

function validateConsensusContext(ctx: {
  cwd?: string;
  agentDir?: string;
  modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string }> };
  model?: { provider: string; id: string };
}) {
  return loadConsensusConfig({
    cwd: ctx.cwd ?? process.cwd(),
    agentDir: ctx.agentDir,
    availableModels: ctx.modelRegistry?.getAvailable?.() ?? [],
    currentModel: ctx.model,
  });
}

type ConsensusProgressState = {
  stage:
    | "config-validation"
    | "participant-pass"
    | "pre-synthesis-gate"
    | "synthesis"
    | "failed";
  selectedParticipants: string[];
  synthesisModel?: string;
  participants: Map<string, "pending" | "running" | "completed" | "failed" | "excluded">;
  synthesis: "pending" | "running" | "response-received" | "validating" | "completed" | "skipped" | "failed";
  failureMessage?: string;
};

function createConsensusProgressState(): ConsensusProgressState {
  return {
    stage: "config-validation",
    selectedParticipants: [],
    participants: new Map(),
    synthesis: "pending",
  };
}

function createProgressParticipantExecutor(
  progress: ConsensusProgressState,
  ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } },
  executor?: ParticipantInvocationExecutor,
): ParticipantInvocationExecutor {
  return async (invocation) => {
    const model = formatModelRef(invocation.model);
    progress.participants.set(model, "running");
    updateConsensusProgress(ctx, progress, `Running participant pass... ${model}`);

    const result = await (executor ?? runParticipantInvocation)(invocation);

    progress.participants.set(model, result.status === "failed" ? "failed" : "completed");
    updateConsensusProgress(ctx, progress, `Participant finished: ${model}`);
    return result;
  };
}

function createProgressSynthesisExecutor(
  progress: ConsensusProgressState,
  ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } },
  executor?: SynthesisInvocationExecutor,
): SynthesisInvocationExecutor {
  return async (invocation) => {
    progress.stage = "synthesis";
    progress.synthesis = "running";
    updateConsensusProgress(ctx, progress, "Running synthesis...");
    return (executor ?? runSynthesisInvocation)(invocation);
  };
}

function updateConsensusProgress(
  ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } },
  progress: ConsensusProgressState,
  status: string,
) {
  if (ctx.hasUI === false) {
    return;
  }

  const statuses = [...progress.participants.values()];
  const usable = statuses.filter((participantStatus) => participantStatus === "completed").length;
  const failed = statuses.filter((participantStatus) => participantStatus === "failed").length;
  const excluded = statuses.filter((participantStatus) => participantStatus === "excluded").length;
  const remaining = statuses.filter((participantStatus) => participantStatus === "pending" || participantStatus === "running").length;

  ctx.ui.setStatus?.("pi-consensus", status);
  ctx.ui.setWidget?.("pi-consensus", [
    "pi-consensus progress",
    `Stage — ${formatProgressStage(progress.stage)}`,
    ...(progress.selectedParticipants.length > 0 ? [`Selected participants — ${progress.selectedParticipants.join(", ")}`] : []),
    ...(progress.synthesisModel ? [`Selected synthesis model — ${progress.synthesisModel}`] : []),
    `Counts — usable: ${usable}, failed: ${failed}, excluded: ${excluded}, remaining: ${remaining}`,
    ...[...progress.participants.entries()].map(([model, participantStatus]) => `${model} — ${participantStatus}`),
    `Synthesis — ${formatSynthesisStatus(progress.synthesis)}`,
    ...(progress.failureMessage ? [`Failure — ${progress.failureMessage}`] : []),
  ]);
}

function clearConsensusProgress(ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } }) {
  if (ctx.hasUI === false) {
    return;
  }

  ctx.ui.setStatus?.("pi-consensus", undefined);
  ctx.ui.setWidget?.("pi-consensus", undefined);
}

function syncFilteredParticipantStatuses(
  progress: ConsensusProgressState,
  participants: Array<{ model: { provider: string; id: string }; status: "usable" | "excluded" | "failed" }>,
) {
  for (const participant of participants) {
    progress.participants.set(
      formatModelRef(participant.model),
      participant.status === "usable" ? "completed" : participant.status,
    );
  }
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

type ParsedConsensusCommand = {
  prompt: string;
  stance?: "for" | "against" | "neutral";
  focus?: "security" | "performance" | "maintainability" | "implementation speed" | "user value";
  error?: string;
};

function parseConsensusCommandArgs(args: string): ParsedConsensusCommand {
  const STANCE_VALUES = ["for", "against", "neutral"] as const;
  const FOCUS_VALUES = ["security", "performance", "maintainability", "implementation speed", "user value"] as const;

  let remaining = args.trim();
  let stance: "for" | "against" | "neutral" | undefined;
  let focus: "security" | "performance" | "maintainability" | "implementation speed" | "user value" | undefined;

  // Parse --stance flag
  const stanceMatch = remaining.match(/--stance\s+(\S+)/);
  if (stanceMatch) {
    const stanceValue = stanceMatch[1] as typeof STANCE_VALUES[number];
    if (!STANCE_VALUES.includes(stanceValue)) {
      return {
        prompt: "",
        error: `Invalid stance "${stanceValue}". Must be one of: ${STANCE_VALUES.join(", ")}.`,
      };
    }
    stance = stanceValue;
    remaining = remaining.replace(stanceMatch[0], "").trim();
  }

  // Parse --focus flag (handle quoted multi-word values)
  const focusMatch = remaining.match(/--focus\s+(?:"([^"]+)"|(\S+))/);
  if (focusMatch) {
    const focusValue = (focusMatch[1] || focusMatch[2]) as typeof FOCUS_VALUES[number];
    if (!FOCUS_VALUES.includes(focusValue)) {
      return {
        prompt: "",
        error: `Invalid focus "${focusValue}". Must be one of: ${FOCUS_VALUES.join(", ")}.`,
      };
    }
    focus = focusValue;
    remaining = remaining.replace(focusMatch[0], "").trim();
  }

  return { prompt: remaining, stance, focus };
}

function formatProgressStage(stage: ConsensusProgressState["stage"]) {
  switch (stage) {
    case "config-validation":
      return "config validation";
    case "participant-pass":
      return "participant pass";
    case "pre-synthesis-gate":
      return "pre-synthesis gate";
    case "synthesis":
      return "synthesis";
    case "failed":
      return "failed";
  }
}

function formatSynthesisStatus(status: ConsensusProgressState["synthesis"]) {
  switch (status) {
    case "pending":
      return "waiting";
    case "response-received":
      return "response received";
    default:
      return status;
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
  model: { provider: string; id: string; stance?: "for" | "against" | "neutral"; focus?: "security" | "performance" | "maintainability" | "implementation speed" | "user value" };
  status: "usable" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
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
    inspectedRepo: participant.inspectedRepo,
    toolNamesUsed: participant.toolNamesUsed,
    stance: participant.model.stance,
    focus: participant.model.focus,
    retried: participant.retried,
    retryReason: participant.retryReason,
  };
}
