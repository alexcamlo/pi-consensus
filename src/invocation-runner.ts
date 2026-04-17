import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  parsePiJsonEventLine,
  readAssistantTextFromMessageEndEvent,
  type PiJsonEvent,
} from "./pi-json-events.ts";

export type PiInvocationRequest = {
  command?: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: PiJsonEvent) => void;
};

export type PiInvocationResult = {
  assistantText: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  abortReason?: unknown;
};

export type PiInvocationRunner = (request: PiInvocationRequest) => Promise<PiInvocationResult>;

export const runPiInvocation: PiInvocationRunner = async (request) => {
  return new Promise((resolve, reject) => {
    const command = request.command ?? "pi";
    const child = spawn(command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let lastAssistantText = "";
    let stderr = "";
    let timedOut = false;

    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, request.timeoutMs)
      : undefined;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      request.abortSignal?.removeEventListener("abort", onAbort);
    };

    const settle = (result: PiInvocationResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 50).unref();
    };

    if (request.abortSignal?.aborted) {
      settle({
        assistantText: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        abortReason: request.abortSignal.reason,
      });
      return;
    }

    request.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const stdout = child.stdout;
    if (stdout) {
      const reader = createInterface({ input: stdout, crlfDelay: Infinity });
      reader.on("line", (line) => {
        const event = parsePiJsonEventLine(line);
        if (!event) {
          return;
        }

        request.onEvent?.(event);

        const assistantText = readAssistantTextFromMessageEndEvent(event);
        if (assistantText) {
          lastAssistantText = assistantText;
        }
      });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      fail(error);
    });

    child.on("close", (code, signal) => {
      settle({
        assistantText: lastAssistantText,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        aborted: request.abortSignal?.aborted ?? false,
        abortReason: request.abortSignal?.reason,
      });
    });
  });
};
