import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { formatModelRef, loadConsensusConfig, type ResolvedConsensusConfig } from "./config.ts";
import {
  filterParticipantOutputs,
  runParticipantInvocation,
  runParticipantPass,
  type ParticipantInvocationExecutor,
} from "./participants.ts";
import { createConsensusExecutionResult } from "./result.ts";
import { runConsensusSynthesis, runSynthesisInvocation, type SynthesisInvocationExecutor } from "./synthesis.ts";

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";
const MESSAGE_TYPE = "consensus-scaffold";

export default function consensusExtension(
  pi: ExtensionAPI,
  dependencies: {
    executeParticipantInvocation?: ParticipantInvocationExecutor;
    executeSynthesisInvocation?: SynthesisInvocationExecutor;
  } = {},
) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      ctx.ui.setStatus("pi-consensus", "pi-consensus loaded (config validation scaffold)");
    }
  });

  pi.registerMessageRenderer(MESSAGE_TYPE, (message) =>
    new Text(typeof message.content === "string" ? message.content : "", 0, 0),
  );

  pi.registerTool({
    name: TOOL_NAME,
    label: "Consensus",
    description: "Run a multi-model consensus workflow for a prompt.",
    promptSnippet: "Run a multi-model consensus workflow when the user explicitly asks for consensus.",
    promptGuidelines: [
      "Use this tool only for explicit consensus requests; do not replace normal pi behavior.",
      "Treat this repo as read-only until the consensus runner is implemented.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The user prompt to evaluate across multiple models." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = validateConsensusContext(ctx);
      const participantPass = await runParticipantPass(
        {
          prompt: params.prompt,
          cwd: ctx.cwd ?? process.cwd(),
          config,
        },
        dependencies.executeParticipantInvocation,
      );
      const filteredParticipants = filterParticipantOutputs(participantPass.participants);
      const synthesis = filteredParticipants.failureMessage
        ? undefined
        : await runConsensusSynthesis(
            {
              prompt: params.prompt,
              cwd: ctx.cwd ?? process.cwd(),
              config,
              usableParticipants: filteredParticipants.usable,
              excludedParticipants: [...filteredParticipants.excluded, ...filteredParticipants.failed],
            },
            dependencies.executeSynthesisInvocation,
          );
      const result = createConsensusExecutionResult(
        params.prompt,
        toScaffoldSummary(config),
        filteredParticipants.participants.map(toParticipantSummary),
        filteredParticipants.failureMessage,
        synthesis?.output,
      );

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Run the pi-consensus workflow for a prompt.",
    handler: async (args, ctx) => {
      const prompt = args.trim();

      if (!prompt) {
        ctx.ui.notify("Usage: /consensus <prompt>", "warning");
        return;
      }

      const progress = createConsensusProgressState();

      try {
        updateConsensusProgress(ctx, progress, "Validating consensus config...");

        const config: ResolvedConsensusConfig = validateConsensusContext(ctx);

        for (const warning of config.warnings) {
          ctx.ui.notify(warning, "warning");
        }

        for (const model of config.models) {
          progress.participants.set(formatModelRef(model), "pending");
        }
        updateConsensusProgress(ctx, progress, "Running participant pass...");

        const participantPass = await runParticipantPass(
          {
            prompt,
            cwd: ctx.cwd ?? process.cwd(),
            config,
          },
          createProgressParticipantExecutor(progress, ctx, dependencies.executeParticipantInvocation),
        );
        const filteredParticipants = filterParticipantOutputs(participantPass.participants);

        if (filteredParticipants.failureMessage) {
          progress.synthesis = "skipped";
          updateConsensusProgress(ctx, progress, "Skipping synthesis...");
        }

        const synthesis = filteredParticipants.failureMessage
          ? undefined
          : await runConsensusSynthesis(
              {
                prompt,
                cwd: ctx.cwd ?? process.cwd(),
                config,
                usableParticipants: filteredParticipants.usable,
                excludedParticipants: [...filteredParticipants.excluded, ...filteredParticipants.failed],
              },
              createProgressSynthesisExecutor(progress, ctx, dependencies.executeSynthesisInvocation),
            );
        const result = createConsensusExecutionResult(
          prompt,
          toScaffoldSummary(config),
          filteredParticipants.participants.map(toParticipantSummary),
          filteredParticipants.failureMessage,
          synthesis?.output,
        );

        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: result.text,
          details: result.details,
          display: true,
        });

        if (filteredParticipants.failureMessage) {
          ctx.ui.notify(filteredParticipants.failureMessage, "error");
          return;
        }

        ctx.ui.notify("pi-consensus participant pass and synthesis completed.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        clearConsensusProgress(ctx);
      }
    },
  });
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
  participants: Map<string, "pending" | "running" | "completed" | "failed">;
  synthesis: "pending" | "running" | "completed" | "skipped";
};

function createConsensusProgressState(): ConsensusProgressState {
  return {
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
    updateConsensusProgress(ctx, progress, `Running participant pass... ${model}`);
    return result;
  };
}

function createProgressSynthesisExecutor(
  progress: ConsensusProgressState,
  ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } },
  executor?: SynthesisInvocationExecutor,
): SynthesisInvocationExecutor {
  return async (invocation) => {
    progress.synthesis = "running";
    updateConsensusProgress(ctx, progress, "Running synthesis...");
    const result = await (executor ?? runSynthesisInvocation)(invocation);
    progress.synthesis = "completed";
    updateConsensusProgress(ctx, progress, "Running synthesis...");
    return result;
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

  ctx.ui.setStatus?.("pi-consensus", status);
  ctx.ui.setWidget?.("pi-consensus", [
    "pi-consensus progress",
    ...[...progress.participants.entries()].map(([model, participantStatus]) => `${model} — ${participantStatus}`),
    `Synthesis — ${progress.synthesis === "pending" ? "waiting" : progress.synthesis}`,
  ]);
}

function clearConsensusProgress(ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } }) {
  if (ctx.hasUI === false) {
    return;
  }

  ctx.ui.setStatus?.("pi-consensus", undefined);
  ctx.ui.setWidget?.("pi-consensus", undefined);
}

function toScaffoldSummary(config: ResolvedConsensusConfig) {
  return {
    configPath: config.configPath,
    participants: config.models.map(formatModelRef),
    synthesisModel: formatModelRef(config.synthesisModel),
    warnings: config.warnings,
  };
}

function toParticipantSummary(participant: {
  model: { provider: string; id: string };
  status: "usable" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
}) {
  return {
    model: formatModelRef(participant.model),
    status: participant.status,
    output: participant.output,
    failureReason: participant.failureReason,
    exclusionReason: participant.exclusionReason,
    inspectedRepo: participant.inspectedRepo,
    toolNamesUsed: participant.toolNamesUsed,
  };
}
