import type { ModelMessage, ToolModelMessage } from "ai";

/**
 * Converts provider-executed tool outcomes into replay-safe model messages.
 *
 * Provider SDKs can return a tool call and its result inside one assistant
 * message. Each matching call is rewritten as a normal call and consecutive
 * results are moved into a tool message at their original position when the
 * call lacks the matching marker or shares an assistant message with a local
 * tool call. Native provider-only call/result pairs stay in the assistant
 * message, but content after their results starts a new assistant message:
 * AI Gateway replays a single message with a result followed by text as if
 * the text came first. Text before a result remains before it; text after a
 * result remains after it. Local tool calls in a split message, with their
 * approval requests, move to its last assistant message, so the local results
 * that follow the response directly follow their calls.
 */
export function normalizeProviderToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly providerExecutedOutcomeIds: ReadonlySet<string>;
}): { readonly messages: ModelMessage[]; readonly outcomeEndsResponse: boolean } {
  const toolCallIdsToNormalize = findProviderToolCallsToNormalize(input);
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
    let afterProviderResult = false;
    const localCallParts: typeof message.content = [];
    const splits = message.content.some(
      (part) => part.type === "tool-result" && toolCallIdsToNormalize.has(part.toolCallId),
    );

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
      } else if (
        splits &&
        part.type === "tool-call" &&
        part.providerExecuted !== true &&
        !toolCallIdsToNormalize.has(part.toolCallId)
      ) {
        // Local results arrive after the whole response. Keeping their calls
        // in an earlier split would put a later provider result between a
        // call and its result, which providers reject.
        localCallParts.push(part);
      } else {
        flushTool();
        // Parallel results stay together; anything else after them closes the message.
        if (afterProviderResult && part.type !== "tool-result") flushAssistant();
        afterProviderResult = part.type === "tool-result";
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

    flushTool();
    assistantContent.push(...localCallParts);
    flushAssistant();
  }

  return {
    messages: normalized,
    outcomeEndsResponse: lastOutcomePosition >= 0 && lastOutcomePosition > lastTextPosition,
  };
}

function findProviderToolCallsToNormalize(input: {
  readonly messages: readonly ModelMessage[];
  readonly providerExecutedOutcomeIds: ReadonlySet<string>;
}): ReadonlySet<string> {
  const result = new Set<string>();

  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const hasLocalToolCall = message.content.some(
      (part) =>
        part.type === "tool-call" &&
        part.providerExecuted !== true &&
        !input.providerExecutedOutcomeIds.has(part.toolCallId),
    );

    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        input.providerExecutedOutcomeIds.has(part.toolCallId) &&
        (part.providerExecuted !== true || hasLocalToolCall)
      ) {
        result.add(part.toolCallId);
      }
    }
  }

  return result;
}
