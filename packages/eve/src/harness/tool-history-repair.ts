import type { ModelMessage } from "ai";

import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { withResult } from "#harness/session-machine/transitions.js";

/** Answer orphaned historical calls without executing them. */
export function repairToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly insertionIndex?: number;
}): { messages: ModelMessage[]; insertionIndex: number | undefined } {
  let messages = [...input.messages];
  let insertionIndex = input.insertionIndex;
  // Any recorded result, even misplaced or inline, belongs to its original history.
  const protectedIds = new Set(extractToolResultCallIds(messages));
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request") protectedIds.add(part.toolCallId);
      if (part.type !== "tool-call") continue;
      if (seen.has(part.toolCallId) || part.providerExecuted === true)
        protectedIds.add(part.toolCallId);
      seen.add(part.toolCallId);
    }
  }
  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call.type !== "tool-call" || protectedIds.has(call.toolCallId)) continue;
      const callIndex = messages.indexOf(message);
      const repaired = withResult(messages, {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "error-text",
          value:
            "The previous attempt ended without a recorded result; execution outcome is unknown; verify external state before repeating side effects.",
        },
      });
      if (
        insertionIndex !== undefined &&
        repaired.length > messages.length &&
        callIndex < insertionIndex
      )
        insertionIndex++;
      messages = repaired;
    }
  }
  return { messages, insertionIndex };
}
