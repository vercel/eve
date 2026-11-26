import type { ModelMessage, ToolCallPart } from "ai";

import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { awaitedProviderToolCallIds } from "#shared/provider-tool-history.js";
import { withResult } from "#harness/session-machine/suspended-steps.js";

export function repairToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly insertionIndex?: number;
  readonly endsRequest?: boolean;
}): { messages: ModelMessage[]; insertionIndex: number | undefined } {
  const closed = closeProviderCalls(input.messages, input.endsRequest === true);
  let messages = [...closed];
  let insertionIndex = input.insertionIndex;
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

function closeProviderCalls(messages: readonly ModelMessage[], endsRequest: boolean) {
  const answered = extractToolResultCallIds(messages);
  const awaited = endsRequest ? awaitedProviderToolCallIds(messages) : new Set<string>();
  const asked = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-approval-request" ? [part.toolCallId] : [],
          )
        : [],
    ),
  );
  return messages.map((message): ModelMessage => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const parts = message.content;
    const local = parts.some((part) => part.type === "tool-call" && part.providerExecuted !== true);
    const dangling = (part: (typeof parts)[number]) =>
      part.type === "tool-call" &&
      part.providerExecuted === true &&
      !answered.has(part.toolCallId) &&
      !awaited.has(part.toolCallId) &&
      !asked.has(part.toolCallId) &&
      !answered.has(anthropicCaller(part.providerOptions) ?? "");
    if (!local || !parts.some(dangling)) return message;
    return {
      ...message,
      content: parts.map((part) =>
        part.type === "tool-call" && dangling(part) ? { ...part, providerExecuted: false } : part,
      ),
    };
  });
}

function anthropicCaller(options: ToolCallPart["providerOptions"]): string | undefined {
  const caller = (options?.anthropic as { caller?: { toolId?: unknown } } | undefined)?.caller;
  return typeof caller?.toolId === "string" ? caller.toolId : undefined;
}
