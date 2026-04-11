import assert from "node:assert/strict";
import test from "node:test";

import consensusExtension from "../src/index.ts";
import { createConsensusScaffoldResult } from "../src/scaffold.ts";

test("createConsensusScaffoldResult returns read-only placeholder details", () => {
  const result = createConsensusScaffoldResult("review this repo");

  assert.match(result.text, /pi-consensus scaffold is installed\./);
  assert.match(result.text, /Prompt: review this repo/);
  assert.equal(result.details.status, "scaffolded");
  assert.equal(result.details.prompt, "review this repo");
  assert.equal(result.details.readOnly, true);
  assert.ok(result.details.nextSteps.length >= 3);
});

test("extension registers consensus command and tool and command reaches placeholder path", async () => {
  let registeredCommand:
    | { description?: string; handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void> }
    | undefined;
  let registeredTool:
    | { execute: (_toolCallId: string, params: { prompt: string }) => Promise<{ content: Array<{ type: string; text: string }>; details: { status: string; prompt: string; readOnly: boolean } }> }
    | undefined;
  let registeredMessageType: string | undefined;
  const sentMessages: Array<{ customType: string; content: string; details: unknown; display: boolean }> = [];

  const fakePi = {
    on: () => {},
    registerMessageRenderer: (messageType: string) => {
      registeredMessageType = messageType;
    },
    registerTool: (tool: typeof registeredTool extends infer T ? T : never) => {
      registeredTool = tool as NonNullable<typeof registeredTool>;
    },
    registerCommand: (
      name: string,
      command: typeof registeredCommand extends infer T ? T : never,
    ) => {
      assert.equal(name, "consensus");
      registeredCommand = command as NonNullable<typeof registeredCommand>;
    },
    sendMessage: (message: { customType: string; content: string; details: unknown; display: boolean }) => {
      sentMessages.push(message);
    },
  };

  consensusExtension(fakePi as never);

  assert.equal(registeredMessageType, "consensus-scaffold");
  assert.ok(registeredTool);
  assert.ok(registeredCommand);

  const commandContext = createCommandContext();
  await registeredCommand.handler("draft a migration plan", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "info",
      message: "pi-consensus scaffold executed; multi-model runner not implemented yet.",
    },
  ]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.customType, "consensus-scaffold");
  assert.match(sentMessages[0]?.content ?? "", /Prompt: draft a migration plan/);

  const toolResult = await registeredTool.execute("tool-call-1", { prompt: "draft a migration plan" });
  assert.match(toolResult.content[0]?.text ?? "", /placeholder execution path only/);
  assert.equal(toolResult.details.prompt, "draft a migration plan");
  assert.equal(toolResult.details.readOnly, true);
});

test("consensus command warns when prompt is missing", async () => {
  let registeredCommand:
    | { handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void> }
    | undefined;

  const fakePi = {
    on: () => {},
    registerMessageRenderer: () => {},
    registerTool: () => {},
    registerCommand: (_name: string, command: NonNullable<typeof registeredCommand>) => {
      registeredCommand = command;
    },
    sendMessage: () => {
      throw new Error("sendMessage should not be called when args are empty");
    },
  };

  consensusExtension(fakePi as never);
  assert.ok(registeredCommand);

  const commandContext = createCommandContext();
  await registeredCommand.handler("   ", commandContext);

  assert.deepEqual(commandContext.notifications, [
    {
      level: "warning",
      message: "Usage: /consensus <prompt>",
    },
  ]);
});

function createCommandContext() {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };
}
