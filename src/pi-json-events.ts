export type PiJsonEvent = Record<string, unknown>;

export function parsePiJsonEventLine(line: string): PiJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as PiJsonEvent;
  } catch {
    return undefined;
  }
}

export function readToolExecutionStartName(event: PiJsonEvent): string | undefined {
  if (event.type !== "tool_execution_start") {
    return undefined;
  }

  return typeof event.toolName === "string" ? event.toolName : undefined;
}

export function readAssistantTextFromMessageEndEvent(event: PiJsonEvent): string | undefined {
  if (event.type !== "message_end") {
    return undefined;
  }

  const assistantText = extractAssistantText(event.message);
  return assistantText || undefined;
}

export function extractAssistantText(message: unknown): string {
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
