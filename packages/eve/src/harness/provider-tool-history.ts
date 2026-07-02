import type { ModelMessage, ToolModelMessage } from "ai";

/**
 * Converts provider-executed tool outcomes into replay-safe model messages.
 *
 * Provider SDKs can return a tool call and its result inside one assistant
 * message. When the result is provider-executed but the call lacks the matching
 * marker, each matching call is rewritten as a normal call and consecutive
 * results are moved into a tool message at their original position. Native
 * provider-owned call/result pairs remain untouched. Text before a result
 * remains before it; text after a result remains after it.
 */
export function normalizeProviderToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly providerExecutedOutcomeIds: ReadonlySet<string>;
}): { readonly messages: ModelMessage[]; readonly outcomeEndsResponse: boolean } {
  const toolCallIdsToNormalize = findUnmarkedProviderToolCalls(input);
  if (input.providerExecutedOutcomeIds.size === 0) {
    return { messages: [...input.messages], outcomeEndsResponse: false };
  }

  const normalized: ModelMessage[] = [];
  let lastOutcomePosition = -1;
  let lastTextPosition = -1;
  let position = 0;

  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      normalized.push(message);
      if (
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
      ) {
        lastTextPosition = position;
      }
      position += 1;
      continue;
    }

    let assistantContent: typeof message.content = [];
    let toolContent: ToolModelMessage["content"] = [];

    const flushAssistant = (): void => {
      if (assistantContent.length === 0) return;
      normalized.push({ ...message, content: assistantContent });
      assistantContent = [];
    };
    const flushTool = (): void => {
      if (toolContent.length === 0) return;
      normalized.push({ role: "tool", content: toolContent });
      toolContent = [];
    };

    for (const part of message.content) {
      if (part.type === "tool-result" && toolCallIdsToNormalize.has(part.toolCallId)) {
        flushAssistant();
        toolContent.push(part);
      } else {
        flushTool();
        assistantContent.push(
          part.type === "tool-call" && toolCallIdsToNormalize.has(part.toolCallId)
            ? { ...part, providerExecuted: false }
            : part,
        );
      }

      if (part.type === "tool-result" && input.providerExecutedOutcomeIds.has(part.toolCallId)) {
        lastOutcomePosition = position;
      } else if (part.type === "text" && part.text.trim().length > 0) {
        lastTextPosition = position;
      }
      position += 1;
    }

    flushAssistant();
    flushTool();
  }

  return {
    messages: normalized,
    outcomeEndsResponse: lastOutcomePosition >= 0 && lastOutcomePosition > lastTextPosition,
  };
}

function findUnmarkedProviderToolCalls(input: {
  readonly messages: readonly ModelMessage[];
  readonly providerExecutedOutcomeIds: ReadonlySet<string>;
}): ReadonlySet<string> {
  const result = new Set<string>();

  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        part.providerExecuted !== true &&
        input.providerExecutedOutcomeIds.has(part.toolCallId)
      ) {
        result.add(part.toolCallId);
      }
    }
  }

  return result;
}
