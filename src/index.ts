import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";

export default function consensusExtension(pi: ExtensionAPI) {
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
      "Treat this repo as read-only until the consensus runner is implemented.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The user prompt to evaluate across multiple models." }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: "text",
            text: [
              "pi-consensus scaffold is installed.",
              `Prompt: ${params.prompt}`,
              "Next step: implement config loading, participant subprocesses, and synthesis.",
            ].join("\n"),
          },
        ],
        details: {
          status: "scaffolded",
          prompt: params.prompt,
        },
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

      ctx.ui.notify("pi-consensus scaffold is installed; runner not implemented yet.", "info");
      ctx.ui.setEditorText(`/consensus ${prompt}`);
    },
  });
}
