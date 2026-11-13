import type { ToolResultPart } from "ai";

import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";

// How the model reads the calls a harness made: as a note from the framework, not as tool calls
// it seems to have made itself. History keeps them as calls, so approval, sign-in, and workflow
// results settle them as they do the model's; only what the model reads changes.

/** Where a call the harness made starts its id, so every reader can tell it from the model's. */
export const HARNESS_CALL_ID_PREFIX = "eve_harness_";

export function isHarnessCallId(callId: string): boolean {
  return callId.startsWith(HARNESS_CALL_ID_PREFIX);
}

/**
 * `messages` as the model reads them: each harness call and its result become one framework
 * message, where the result was. The model's own calls beside them are unchanged.
 */
export function showHarnessCalls(messages: readonly HarnessModelMessage[]): HarnessModelMessage[] {
  if (!messages.some(madeByHarness)) return [...messages];
  const asked = new Map<string, { readonly tool: string; readonly input: unknown }>();
  const shown: HarnessModelMessage[] = [];
  for (const message of messages) {
    if (madeByHarness(message) && message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call")
          asked.set(part.toolCallId, { input: part.input, tool: part.toolName });
      }
      continue;
    }
    if (message.role !== "tool") {
      shown.push(message);
      continue;
    }
    const ours = message.content.filter(
      (part): part is ToolResultPart =>
        part.type === "tool-result" && isHarnessCallId(part.toolCallId),
    );
    if (ours.length === 0) {
      shown.push(message);
      continue;
    }
    const rest = message.content.filter((part) => !ours.includes(part as ToolResultPart));
    if (rest.length > 0) shown.push({ ...message, content: rest });
    const lines = ours.map((part) => {
      const call = asked.get(part.toolCallId);
      return `- ${part.toolName}(${JSON.stringify(call?.input ?? {})}) returned: ${renderOutput(part.output)}`;
    });
    shown.push(
      createFrameworkUserMessage(
        "context.state",
        `The agent's harness made these calls itself, not you:\n${lines.join("\n")}`,
      ),
    );
  }
  return shown;
}

/** A message holding only calls the harness made. */
function madeByHarness(message: HarnessModelMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  const calls = message.content.filter((part) => part.type === "tool-call");
  return (
    calls.length > 0 &&
    calls.length === message.content.length &&
    calls.every((part) => isHarnessCallId(part.toolCallId))
  );
}

function renderOutput(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
    default:
      return JSON.stringify(output);
  }
}
