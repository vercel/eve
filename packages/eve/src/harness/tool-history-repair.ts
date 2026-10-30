import type { ModelMessage } from "ai";

import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { awaitedProviderToolCallIds } from "#harness/provider-tool-history.js";
import { withResult } from "#harness/session-machine/suspended-steps.js";

/** Answer orphaned historical calls without executing them. */
export function repairToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly insertionIndex?: number;
  /** Nothing follows `messages` in the request, so a provider result they await can still come. */
  readonly endsRequest?: boolean;
}): { messages: ModelMessage[]; insertionIndex: number | undefined } {
  const closed = closeProviderCalls(input.messages, input.endsRequest === true);
  let messages = [...closed];
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
  for (const message of closed) {
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

/**
 * A provider tool called beside local tools can defer its result to the next response, which
 * must directly follow the local results. Once anything else follows them, such as a cancelled
 * turn's message, a retry note, or a new turn's input, that result can no longer come and the
 * provider rejects the dangling call. It becomes an ordinary call, answered like any orphan, as
 * `normalizeProviderToolHistory` rewrites a provider call that shares a message with local calls.
 */
function closeProviderCalls(messages: readonly ModelMessage[], endsRequest: boolean) {
  const answered = extractToolResultCallIds(messages);
  const awaited = endsRequest ? awaitedProviderToolCallIds(messages) : new Set<string>();
  return messages.map((message): ModelMessage => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const parts = message.content;
    const local = parts.some((part) => part.type === "tool-call" && part.providerExecuted !== true);
    const dangling = (part: (typeof parts)[number]) =>
      part.type === "tool-call" &&
      part.providerExecuted === true &&
      !answered.has(part.toolCallId) &&
      !awaited.has(part.toolCallId);
    if (!local || !parts.some(dangling)) return message;
    return {
      ...message,
      content: parts.map((part) =>
        part.type === "tool-call" && dangling(part) ? { ...part, providerExecuted: false } : part,
      ),
    };
  });
}
