import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { formatModelRef, type ConsensusModelRef, type ResolvedConsensusConfig } from "./config.ts";

export const PARTICIPANT_TOOLS = ["read", "ls", "find", "grep"] as const;

export type ParticipantInvocation = {
  model: ConsensusModelRef;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  thinking?: ResolvedConsensusConfig["participantThinking"];
  timeoutMs?: number;
  piCommand?: string;
  env?: NodeJS.ProcessEnv;
};

export type ParticipantExecutionResult = {
  model: ConsensusModelRef;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
};

export type ParticipantInvocationExecutor = (
  invocation: ParticipantInvocation,
) => Promise<ParticipantExecutionResult>;

export type ParticipantPassResult = {
  participants: ParticipantExecutionResult[];
};

export type FilteredParticipantResult = {
  model: ConsensusModelRef;
  status: "usable" | "excluded" | "failed";
  output?: string;
  failureReason?: string;
  exclusionReason?: string;
  inspectedRepo: boolean;
  toolNamesUsed: string[];
};

export type ParticipantFilteringResult = {
  participants: FilteredParticipantResult[];
  usable: FilteredParticipantResult[];
  excluded: FilteredParticipantResult[];
  failed: FilteredParticipantResult[];
  failureMessage?: string;
};

export async function runParticipantPass(
  options: {
    prompt: string;
    cwd: string;
    config: ResolvedConsensusConfig;
  },
  executeParticipantInvocation: ParticipantInvocationExecutor = runParticipantInvocation,
): Promise<ParticipantPassResult> {
  const { prompt, cwd, config } = options;

  const participants = await Promise.all(
    config.models.map(async (model) => {
      const invocation: ParticipantInvocation = {
        model,
        cwd,
        prompt,
        systemPrompt: createParticipantSystemPrompt(),
        allowedTools: [...PARTICIPANT_TOOLS],
        thinking: config.participantThinking,
        timeoutMs: config.participantTimeoutMs,
      };

      try {
        return await executeParticipantInvocation(invocation);
      } catch (error) {
        return {
          model,
          status: "failed",
          failureReason: error instanceof Error ? error.message : String(error),
          inspectedRepo: false,
          toolNamesUsed: [],
        } satisfies ParticipantExecutionResult;
      }
    }),
  );

  return { participants };
}

export function filterParticipantOutputs(participants: ParticipantExecutionResult[]): ParticipantFilteringResult {
  const filteredParticipants = participants.map(classifyParticipantOutput);
  const usable = filteredParticipants.filter((participant) => participant.status === "usable");
  const excluded = filteredParticipants.filter((participant) => participant.status === "excluded");
  const failed = filteredParticipants.filter((participant) => participant.status === "failed");

  return {
    participants: filteredParticipants,
    usable,
    excluded,
    failed,
    failureMessage:
      usable.length >= 2
        ? undefined
        : `Consensus requires at least 2 usable participant outputs but only ${usable.length} remained after filtering.`,
  };
}

export function createParticipantSystemPrompt() {
  return [
    "You are participating in a read-only first-pass consensus run.",
    "Answer the user's prompt directly and choose one primary recommendation.",
    "If the user's request depends on repository context, inspect the relevant files before answering.",
    `You may only use these tools: ${PARTICIPANT_TOOLS.join(", ")}.`,
    "Never edit or write files.",
    "Structure your answer with: recommendation, why, risks/tradeoffs, and confidence.",
  ].join(" ");
}

export async function runParticipantInvocation(invocation: ParticipantInvocation): Promise<ParticipantExecutionResult> {
  return new Promise((resolve) => {
    const command = invocation.piCommand ?? "pi";
    const args = buildParticipantCommand(invocation);
    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastAssistantText = "";
    let stderr = "";
    let timedOut = false;
    const toolNamesUsed = new Set<string>();

    const timeout = invocation.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, invocation.timeoutMs)
      : undefined;

    const stdout = child.stdout;
    if (stdout) {
      const reader = createInterface({ input: stdout, crlfDelay: Infinity });
      reader.on("line", (line) => {
        const event = parseJsonLine(line);
        if (!event || typeof event !== "object") {
          return;
        }

        if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
          toolNamesUsed.add(event.toolName);
        }

        if (event.type === "message_end") {
          const assistantText = extractAssistantText(event.message);
          if (assistantText) {
            lastAssistantText = assistantText;
          }
        }
      });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        model: invocation.model,
        status: "failed",
        failureReason: error.message,
        inspectedRepo: false,
        toolNamesUsed: [],
      });
    });

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);

      const toolNames = [...toolNamesUsed];
      if (timedOut) {
        resolve({
          model: invocation.model,
          status: "failed",
          failureReason: `participant subprocess timed out after ${invocation.timeoutMs}ms`,
          inspectedRepo: toolNames.length > 0,
          toolNamesUsed: toolNames,
        });
        return;
      }

      if (code === 0 && lastAssistantText.trim().length > 0) {
        resolve({
          model: invocation.model,
          status: "completed",
          output: lastAssistantText.trim(),
          inspectedRepo: toolNames.length > 0,
          toolNamesUsed: toolNames,
        });
        return;
      }

      const failureReason = [
        code !== 0 ? `participant subprocess exited with code ${code}${signal ? ` (${signal})` : ""}` : undefined,
        stderr.trim() || undefined,
        !lastAssistantText.trim() ? "participant produced no assistant output" : undefined,
      ]
        .filter(Boolean)
        .join(": ");

      resolve({
        model: invocation.model,
        status: "failed",
        failureReason: failureReason || "participant subprocess failed",
        inspectedRepo: toolNames.length > 0,
        toolNamesUsed: toolNames,
      });
    });
  });
}

export function buildParticipantCommand(invocation: ParticipantInvocation) {
  return [
    "--mode",
    "json",
    "--model",
    formatModelRef(invocation.model),
    ...(invocation.thinking ? ["--thinking", invocation.thinking] : []),
    "--tools",
    invocation.allowedTools.join(","),
    "--append-system-prompt",
    invocation.systemPrompt,
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    invocation.prompt,
  ];
}

function classifyParticipantOutput(participant: ParticipantExecutionResult): FilteredParticipantResult {
  if (participant.status === "failed") {
    return {
      ...participant,
      status: "failed",
    };
  }

  const output = participant.output?.trim() ?? "";
  if (!output) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "empty response",
    };
  }

  if (looksLikeRefusalOnly(output)) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "refusal-only response",
    };
  }

  if (looksTooVague(output)) {
    return {
      ...participant,
      status: "excluded",
      output,
      exclusionReason: "response was too vague to use for consensus",
    };
  }

  return {
    ...participant,
    status: "usable",
    output,
  };
}

function looksLikeRefusalOnly(output: string) {
  const normalized = output.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length > 220) {
    return false;
  }

  return [
    /^(i('|’)m sorry[, ]+but )?i can('|’)t help with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i cannot help with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i can('|’)t assist with that[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i cannot comply with that request[.!]?$/,
    /^(i('|’)m sorry[, ]+but )?i don('|’)t have enough information to answer[.!]?$/,
  ].some((pattern) => pattern.test(normalized));
}

function looksTooVague(output: string) {
  const normalized = output.replace(/\s+/g, " ").trim();
  if (normalized.length >= 40) {
    return false;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount <= 6;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAssistantText(message: unknown) {
  if (!message || typeof message !== "object") {
    return "";
  }

  const role = Reflect.get(message, "role");
  if (role !== "assistant") {
    return "";
  }

  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      const type = Reflect.get(block, "type");
      if (type !== "text") {
        return "";
      }

      const text = Reflect.get(block, "text");
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}
