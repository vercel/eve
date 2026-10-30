// The history eve keeps of a conversation an older execution model recorded, as both importers read
// it: the legacy-session driver import and the pre-v27 handoff import.

import type { ModelMessage } from "ai";
import { isUserMessageKind, validateHarnessModelMessages } from "#harness/messages.js";

export function normalizeHistory(messages: readonly ModelMessage[]) {
  const history: ModelMessage[] = [];
  const pending = new Map<string, string>();
  const settle = () => {
    if (pending.size === 0) return;
    history.push({
      role: "tool",
      content: [...pending].map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: {
          type: "error-text" as const,
          value: "Interrupted by the session upgrade. Start this work again if it is still needed.",
        },
      })),
    });
    pending.clear();
  };
  for (const original of messages) {
    let message = original;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      message = {
        ...message,
        content: message.content.filter((part) => part.type !== "tool-approval-request"),
      };
    } else if (message.role === "tool") {
      message = {
        ...message,
        content: message.content.filter((part) => part.type !== "tool-approval-response"),
      };
      if (message.content.length === 0) continue;
    }
    if (message.role !== "tool") settle();
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content)
        if (part.type === "tool-call") pending.set(part.toolCallId, part.toolName);
    }
    if (message.role === "tool") {
      for (const part of message.content)
        if (part.type === "tool-result") pending.delete(part.toolCallId);
    }
    const kind = (message as { kind?: unknown }).kind;
    history.push(
      message.role === "user" && !isUserMessageKind(kind)
        ? ({ ...message, kind: "user" } as ModelMessage)
        : message,
    );
  }
  settle();
  return validateHarnessModelMessages(history);
}
