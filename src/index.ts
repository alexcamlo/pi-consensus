import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { createConsensusScaffoldResult } from "./scaffold.ts";

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";
const MESSAGE_TYPE = "consensus-scaffold";

export default function consensusExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      ctx.ui.setStatus("pi-consensus", "pi-consensus loaded (scaffold)");
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
    async execute(_toolCallId, params) {
      const result = createConsensusScaffoldResult(params.prompt);

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

      const result = createConsensusScaffoldResult(prompt);

      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: result.text,
        details: result.details,
        display: true,
      });

      ctx.ui.notify("pi-consensus scaffold executed; multi-model runner not implemented yet.", "info");
    },
  });
}
