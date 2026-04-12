import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { formatModelRef, loadConsensusConfig, type ResolvedConsensusConfig } from "./config.ts";
import { filterParticipantOutputs, runParticipantPass, type ParticipantInvocationExecutor } from "./participants.ts";
import { createConsensusExecutionResult } from "./result.ts";

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";
const MESSAGE_TYPE = "consensus-scaffold";

export default function consensusExtension(
  pi: ExtensionAPI,
  dependencies: { executeParticipantInvocation?: ParticipantInvocationExecutor } = {},
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
      const result = createConsensusExecutionResult(
        params.prompt,
        toScaffoldSummary(config),
        filteredParticipants.participants.map(toParticipantSummary),
        filteredParticipants.failureMessage,
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

      let config: ResolvedConsensusConfig;
      try {
        config = validateConsensusContext(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      for (const warning of config.warnings) {
        ctx.ui.notify(warning, "warning");
      }

      const participantPass = await runParticipantPass(
        {
          prompt,
          cwd: ctx.cwd ?? process.cwd(),
          config,
        },
        dependencies.executeParticipantInvocation,
      );
      const filteredParticipants = filterParticipantOutputs(participantPass.participants);
      const result = createConsensusExecutionResult(
        prompt,
        toScaffoldSummary(config),
        filteredParticipants.participants.map(toParticipantSummary),
        filteredParticipants.failureMessage,
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

      ctx.ui.notify("pi-consensus participant pass executed; usable outputs collected and synthesis is not implemented yet.", "info");
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
