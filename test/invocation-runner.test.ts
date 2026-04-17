import assert from "node:assert/strict";
import test from "node:test";

import { runPiInvocation } from "../src/invocation-runner.ts";

test("runPiInvocation captures assistant message_end text and forwards JSON events", async () => {
  const seenEventTypes: string[] = [];

  const result = await runPiInvocation({
    command: process.execPath,
    args: [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }));",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }));",
      ].join("\n"),
    ],
    cwd: process.cwd(),
    onEvent: (event) => {
      if (typeof event.type === "string") {
        seenEventTypes.push(event.type);
      }
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.assistantText, "hello world");
  assert.deepEqual(seenEventTypes, ["tool_execution_start", "message_end"]);
});

test("runPiInvocation captures stderr and non-zero exit metadata", async () => {
  const result = await runPiInvocation({
    command: process.execPath,
    args: [
      "-e",
      "process.stderr.write('boom'); process.exit(7);",
    ],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "boom");
  assert.equal(result.assistantText, "");
  assert.equal(result.timedOut, false);
});
