import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Container } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  createConsensusOrchestrator,
  type ConsensusOrchestratorDeps,
  type ConsensusRunProgress,
  type ParticipantProgressStatus,
  type SynthesisProgressStatus,
} from "./orchestrator.ts";

const TOOL_NAME = "consensus";
const COMMAND_NAME = "consensus";
const COMMAND_MESSAGE_TYPE = "consensus-command";

export default function consensusExtension(
  pi: ExtensionAPI,
  dependencies: ConsensusOrchestratorDeps = {},
) {
  const orchestrator = createConsensusOrchestrator(dependencies);

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
      stance: Type.Optional(Type.String({ description: "One-run override for all participants: for, against, or neutral. Prefer per-model stance in config for normal use." })),
      focus: Type.Optional(Type.String({ description: "One-run override for all participants: security, performance, maintainability, implementation speed, or user value. Prefer per-model focus in config for normal use." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        return await orchestrator.execute(
          {
            prompt: params.prompt,
            overrides: {
              stance: params.stance as "for" | "against" | "neutral" | undefined,
              focus: params.focus as "security" | "performance" | "maintainability" | "implementation speed" | "user value" | undefined,
            },
          },
          {
            cwd: ctx.cwd ?? process.cwd(),
            agentDir: (ctx as { agentDir?: string }).agentDir,
            currentModel: ctx.model,
            availableModels: ctx.modelRegistry?.getAvailable?.() ?? [],
          },
          {
            onProgress: (event) => updateConsensusProgress(ctx, event),
            notify: (message, level) => ctx.ui.notify(message, level),
          },
        );
      } finally {
        clearConsensusProgress(ctx);
      }
    },
    renderResult(result) {
      const container = new Container();

      const markdownText = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (markdownText) {
        const mdTheme = getMarkdownTheme();
        const md = new Markdown(markdownText, 0, 0, mdTheme);
        container.addChild(md);
      }

      return container;
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Run the pi-consensus workflow for a prompt. Prefer per-model stance/focus in config; optional --stance/--focus flags override all participants for one run.",
    handler: async (args, ctx) => {
      const parsed = parseConsensusCommandArgs(args.trim());

      if (parsed.error) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      if (!parsed.prompt) {
        ctx.ui.notify("Usage: /consensus [--stance for|against|neutral] [--focus security|performance|maintainability|\"implementation speed\"|\"user value\"] <prompt>\nPer-model stance/focus belongs in .pi/consensus.json; flags override all participants for this run only.", "warning");
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

function updateConsensusProgress(
  ctx: { hasUI?: boolean; ui: { setWidget?: (key: string, widget?: string[]) => void } },
  progress: ConsensusRunProgress,
) {
  if (ctx.hasUI === false) {
    return;
  }

  const participantEntries: Array<[string, ParticipantProgressStatus]> = progress.participants.map((participant) => [
    participant.model,
    participant.status,
  ]);
  const statuses = participantEntries.map(([, participantStatus]) => participantStatus);
  const usable = statuses.filter((participantStatus) => participantStatus === "completed").length;
  const failed = statuses.filter((participantStatus) => participantStatus === "failed").length;
  const excluded = statuses.filter((participantStatus) => participantStatus === "excluded").length;
  const remaining = statuses.filter((participantStatus) => participantStatus === "pending" || participantStatus === "running" || participantStatus === "retrying").length;
  const total = participantEntries.length;
  const finished = total - remaining;

  ctx.ui.setWidget?.("pi-consensus", [
    "pi-consensus",
    "",
    `Stage      ${formatProgressStage(progress.stage)}`,
    total > 0
      ? `Progress   ${renderProgressBar(finished, total)} ${formatProgressSummary(finished, total, usable, failed, excluded)}`
      : `Progress   ${renderProgressBar(0, 1)} 0/0 done`,
    `Synth      ${formatSynthesisStatusWithIndicator(progress.synthesis)}`,
    "",
    ...formatParticipantStateLines(participantEntries),
    ...(progress.failureMessage ? ["", `Failure    ${progress.failureMessage}`] : []),
  ]);
}

function clearConsensusProgress(ctx: { hasUI?: boolean; ui: { setStatus?: (key: string, status?: string) => void; setWidget?: (key: string, widget?: string[]) => void } }) {
  if (ctx.hasUI === false) {
    return;
  }

  ctx.ui.setStatus?.("pi-consensus", undefined);
  ctx.ui.setWidget?.("pi-consensus", undefined);
}

function formatProgressStage(stage: ConsensusRunProgress["stage"]) {
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

function formatSynthesisStatus(status: SynthesisProgressStatus) {
  switch (status) {
    case "pending":
      return "waiting";
    case "response-received":
      return "response received";
    case "retrying":
      return "retrying";
    case "degraded":
      return "degraded";
    default:
      return status;
  }
}

function formatSynthesisStatusWithIndicator(status: SynthesisProgressStatus) {
  const label = formatSynthesisStatus(status);
  switch (status) {
    case "running":
    case "response-received":
    case "validating":
      return `● ${label}`;
    case "retrying":
      return `↻ ${label}`;
    case "completed":
      return `✓ ${label}`;
    case "degraded":
      return `⚠ ${label}`;
    case "skipped":
      return `− ${label}`;
    case "failed":
      return `× ${label}`;
    default:
      return `○ ${label}`;
  }
}

function formatParticipantStateLines(entries: Array<[string, ParticipantProgressStatus]>) {
  const groups: Array<{ label: string; icon: string; statuses: ParticipantProgressStatus[] }> = [
    { label: "Running", icon: "●", statuses: ["running"] },
    { label: "Retrying", icon: "↻", statuses: ["retrying"] },
    { label: "Done", icon: "✓", statuses: ["completed"] },
    { label: "Queued", icon: "○", statuses: ["pending"] },
    { label: "Failed", icon: "×", statuses: ["failed"] },
    { label: "Excluded", icon: "−", statuses: ["excluded"] },
  ];

  const lines: string[] = [];
  for (const group of groups) {
    const models = entries
      .filter(([, status]) => group.statuses.includes(status))
      .map(([model]) => formatProgressModelLabel(model));
    if (models.length === 0) {
      continue;
    }
    lines.push(`${group.label.padEnd(10, " ")}${group.icon} ${models.join(", ")}`);
  }

  return lines;
}

function formatProgressSummary(finished: number, total: number, usable: number, failed: number, excluded: number) {
  const parts = [`${finished}/${total} done`, `${usable} ok`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (excluded > 0) {
    parts.push(`${excluded} excluded`);
  }
  return parts.join(" · ");
}

function formatProgressModelLabel(model: string) {
  const parts = model.split("/");
  if (parts.length >= 2) {
    return parts[parts.length - 1] ?? model;
  }
  return model;
}

function renderProgressBar(completed: number, total: number, width = 10) {
  const safeTotal = Math.max(total, 1);
  const filled = Math.max(0, Math.min(width, Math.round((completed / safeTotal) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
