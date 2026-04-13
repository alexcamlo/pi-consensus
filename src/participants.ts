import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { formatModelRef, type ConsensusModelRef, type ResolvedConsensusConfig } from "./config.ts";

export const PARTICIPANT_TOOL_CANDIDATES = ["read", "ls", "find", "grep", "multi_grep"] as const;
export const SUBPROCESS_SAFE_PARTICIPANT_TOOLS = ["read", "ls", "find", "grep"] as const;

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
  abortSignal?: AbortSignal;
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

export type ParticipantRetryInfo = {
  attempt: number;
  maxRetries: number;
  isRetry: boolean;
};

export type ParticipantInvocationExecutorWithRetry = (
  invocation: ParticipantInvocation,
  retryInfo: ParticipantRetryInfo,
) => Promise<ParticipantExecutionResult>;

export type ParticipantPassResult = {
  participants: ParticipantExecutionResult[];
  stoppedEarly: boolean;
  earlyStopReason?: string;
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

export type UsableParticipantResult = FilteredParticipantResult & { status: "usable"; output: string };
export type ExcludedParticipantResult = FilteredParticipantResult & { status: "excluded" };
export type FailedParticipantResult = FilteredParticipantResult & { status: "failed" };

export type ParticipantFilteringResult = {
  participants: FilteredParticipantResult[];
  usable: UsableParticipantResult[];
  excluded: ExcludedParticipantResult[];
  failed: FailedParticipantResult[];
  failureMessage?: string;
  stoppedEarly: boolean;
  earlyStopReason?: string;
};

export const MINIMUM_USABLE_PARTICIPANTS = 2;
export const EARLY_STOP_FAILURE_REASON =
  "participant subprocess cancelled because reaching the minimum 2 usable participants became impossible";

const TRANSIENT_FAILURE_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /connection refused/i,
  /socket hang up/i,
  /network error/i,
  /transport/i,
  /temporarily unavailable/i,
  /rate limit/i,
  /too many requests/i,
  /exited with code \d+.*\n?.*(?:no assistant output|empty)/i,
] as const;

export function isTransientFailure(failureReason: string): boolean {
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(failureReason));
}

export async function runParticipantPass(
  options: {
    prompt: string;
    cwd: string;
    config: ResolvedConsensusConfig;
  },
  executeParticipantInvocation: ParticipantInvocationExecutor = runParticipantInvocation,
): Promise<ParticipantPassResult> {
  const { prompt, cwd, config } = options;
  const concurrency = config.participantConcurrency;
  const maxRetries = config.participantMaxRetries;

  const participants = new Array<ParticipantExecutionResult>(config.models.length);
  const abortControllers = config.models.map(() => new AbortController());

  let settledCount = 0;
  let usableCount = 0;
  let stoppedEarly = false;
  let earlyStopReason: string | undefined;

  const executeWithRetry = createRetryExecutor(executeParticipantInvocation, maxRetries);

  // Semaphore for bounded concurrency using a simpler slot-based approach
  let activeCount = 0;
  const pendingQueue: Array<() => void> = [];

  const acquireSlot = async (): Promise<void> => {
    if (activeCount < concurrency) {
      activeCount++;
      return;
    }
    return new Promise((resolve) => pendingQueue.push(resolve));
  };

  const releaseSlot = (): void => {
    activeCount--;
    const next = pendingQueue.shift();
    if (next) {
      activeCount++;
      next();
    }
  };

  const maybeStopEarly = () => {
    const remaining = config.models.length - settledCount;
    if (stoppedEarly || usableCount + remaining >= MINIMUM_USABLE_PARTICIPANTS) {
      return false;
    }

    stoppedEarly = true;
    earlyStopReason = `Consensus stopped early because only ${usableCount} usable participant output${usableCount === 1 ? "" : "s"} remained and ${remaining} participant run${remaining === 1 ? " was" : "s were"} still in flight, so reaching the minimum ${MINIMUM_USABLE_PARTICIPANTS} usable participants became impossible.`;

    abortControllers.forEach((controller, index) => {
      if (!participants[index]) {
        controller.abort(earlyStopReason);
      }
    });

    return true;
  };

  const runParticipant = async (model: ConsensusModelRef, index: number): Promise<void> => {
    await acquireSlot();

    try {
      // Check if already aborted before starting
      if (abortControllers[index].signal.aborted) {
        participants[index] = {
          model,
          status: "failed",
          failureReason: typeof abortControllers[index].signal.reason === "string"
            ? abortControllers[index].signal.reason
            : EARLY_STOP_FAILURE_REASON,
          inspectedRepo: false,
          toolNamesUsed: [],
        };
        return;
      }

      const invocation: ParticipantInvocation = {
        model,
        cwd,
        prompt,
        systemPrompt: createParticipantSystemPrompt(),
        allowedTools: [...SUBPROCESS_SAFE_PARTICIPANT_TOOLS],
        thinking: config.participantThinking,
        timeoutMs: config.participantTimeoutMs,
        abortSignal: abortControllers[index].signal,
      };

      const result = await executeWithRetry(invocation);
      participants[index] = result;
      if (classifyParticipantOutput(result).status === "usable") {
        usableCount += 1;
      }
    } catch (error) {
      participants[index] = {
        model,
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
        inspectedRepo: false,
        toolNamesUsed: [],
      } satisfies ParticipantExecutionResult;
    } finally {
      settledCount += 1;
      maybeStopEarly();
      releaseSlot();
    }
  };

  await Promise.all(config.models.map((model, index) => runParticipant(model, index)));

  return { participants, stoppedEarly, earlyStopReason };
}

function createRetryExecutor(
  executeParticipantInvocation: ParticipantInvocationExecutor,
  maxRetries: number,
): ParticipantInvocationExecutor {
  return async (invocation: ParticipantInvocation): Promise<ParticipantExecutionResult> => {
    let lastResult: ParticipantExecutionResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await executeParticipantInvocation(invocation);

      // If completed successfully, return immediately
      if (result.status === "completed") {
        return result;
      }

      lastResult = result;
      const failureReason = result.failureReason ?? "";

      // Only retry transient failures, and only if we haven't exhausted retries
      if (attempt < maxRetries && isTransientFailure(failureReason)) {
        continue;
      }

      // Non-transient failure or exhausted retries
      break;
    }

    return lastResult!;
  };
}

export function filterParticipantOutputs(
  participants: ParticipantExecutionResult[],
  options: { stoppedEarly?: boolean; earlyStopReason?: string } = {},
): ParticipantFilteringResult {
  const filteredParticipants = participants.map(classifyParticipantOutput);
  const usable = filteredParticipants.filter(isUsableParticipant);
  const excluded = filteredParticipants.filter(isExcludedParticipant);
  const failed = filteredParticipants.filter(isFailedParticipant);

  return {
    participants: filteredParticipants,
    usable,
    excluded,
    failed,
    stoppedEarly: options.stoppedEarly ?? false,
    earlyStopReason: options.earlyStopReason,
    failureMessage:
      usable.length >= MINIMUM_USABLE_PARTICIPANTS
        ? undefined
        : options.stoppedEarly && options.earlyStopReason
          ? `${options.earlyStopReason} Consensus requires at least ${MINIMUM_USABLE_PARTICIPANTS} usable participant outputs but only ${usable.length} remained after filtering.`
          : `Consensus requires at least ${MINIMUM_USABLE_PARTICIPANTS} usable participant outputs but only ${usable.length} remained after filtering.`,
  };
}

export function createParticipantSystemPrompt() {
  return [
    "You are participating in a read-only first-pass consensus run.",
    "Answer the user's prompt directly and choose one primary recommendation.",
    "If the user's request depends on repository context, inspect the relevant files before answering.",
    `You may only use these tools: ${SUBPROCESS_SAFE_PARTICIPANT_TOOLS.join(", ")}.`,
    "Never edit or write files.",
    "Your response must include all of the following sections:",
    "- Recommendation: A clear, actionable recommendation that answers the user's prompt.",
    "- Why: Rationale explaining your reasoning and how you reached this recommendation.",
    "- Risks/tradeoffs: Potential downsides, risks, or tradeoffs of your recommendation.",
    "- Confidence: Your confidence level (e.g., high, medium, low) with a brief justification.",
    "- Repo evidence: When relevant, cite specific files, patterns, or evidence from the repository that support your recommendation.",
    "Be specific and concrete; vague or overly brief responses may be excluded from consensus.",
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

    let settled = false;
    const finish = (result: ParticipantExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) clearTimeout(timeout);
      invocation.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

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

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 50).unref();
    };

    if (invocation.abortSignal) {
      if (invocation.abortSignal.aborted) {
        finish({
          model: invocation.model,
          status: "failed",
          failureReason: typeof invocation.abortSignal.reason === "string" ? invocation.abortSignal.reason : EARLY_STOP_FAILURE_REASON,
          inspectedRepo: false,
          toolNamesUsed: [],
        });
        return;
      }

      invocation.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

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
      finish({
        model: invocation.model,
        status: "failed",
        failureReason: error.message,
        inspectedRepo: false,
        toolNamesUsed: [],
      });
    });

    child.on("close", (code, signal) => {
      const toolNames = [...toolNamesUsed];
      if (timedOut) {
        finish({
          model: invocation.model,
          status: "failed",
          failureReason: `participant subprocess timed out after ${invocation.timeoutMs}ms`,
          inspectedRepo: toolNames.length > 0,
          toolNamesUsed: toolNames,
        });
        return;
      }

      if (invocation.abortSignal?.aborted) {
        finish({
          model: invocation.model,
          status: "failed",
          failureReason:
            typeof invocation.abortSignal.reason === "string" ? invocation.abortSignal.reason : EARLY_STOP_FAILURE_REASON,
          inspectedRepo: toolNames.length > 0,
          toolNamesUsed: toolNames,
        });
        return;
      }

      if (code === 0 && lastAssistantText.trim().length > 0) {
        finish({
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

      finish({
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

function isUsableParticipant(participant: FilteredParticipantResult): participant is UsableParticipantResult {
  return participant.status === "usable";
}

function isExcludedParticipant(participant: FilteredParticipantResult): participant is ExcludedParticipantResult {
  return participant.status === "excluded";
}

function isFailedParticipant(participant: FilteredParticipantResult): participant is FailedParticipantResult {
  return participant.status === "failed";
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
