import type { ModelMessage, ToolModelMessage } from "ai";

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
        localCallParts.push(part);
      } else {
        flushTool();
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

export function awaitsProviderToolResult(messages: readonly ModelMessage[]): boolean {
  return awaitedProviderToolCallIds(messages).size > 0;
}

export function awaitedProviderToolCallIds(messages: readonly ModelMessage[]): ReadonlySet<string> {
  let index = messages.length;
  while (index > 0 && messages[index - 1]!.role === "tool") index -= 1;
  const calls = messages[index - 1];
  if (index === messages.length || calls?.role !== "assistant" || !Array.isArray(calls.content)) {
    return new Set();
  }
  const answered = new Set<string>();
  for (const part of [...calls.content, ...messages.slice(index).flatMap(toolContent)]) {
    if (part.type === "tool-result") answered.add(part.toolCallId);
  }
  return new Set(
    calls.content.flatMap((part) =>
      part.type === "tool-call" && part.providerExecuted === true && !answered.has(part.toolCallId)
        ? [part.toolCallId]
        : [],
    ),
  );
}

function toolContent(message: ModelMessage): ToolModelMessage["content"] {
  return message.role === "tool" ? message.content : [];
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
