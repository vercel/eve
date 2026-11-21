import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from "ai";

import { isObject } from "#shared/guards.js";

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

export function flattenProviderToolHistory(
  messages: readonly ModelMessage[],
  toolNames: ReadonlySet<string> = new Set(),
): ModelMessage[] {
  if (toolNames.size === 0) return [...messages];
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return [{ ...message, content: message.content.map((part) => flattenPart(part, toolNames)) }];
    }
    if (message.role !== "tool") return [message];
    const flattened = message.content.flatMap((part) =>
      part.type === "tool-result" && toolNames.has(part.toolName) ? [part] : [],
    );
    if (flattened.length === 0) return [message];
    const kept = message.content.filter(
      (part) => part.type !== "tool-result" || !toolNames.has(part.toolName),
    );
    return [
      ...(kept.length > 0 ? [{ ...message, content: kept }] : []),
      {
        role: "assistant",
        content: flattened.map((part) => ({ type: "text", text: describeToolResult(part) })),
      },
    ];
  });
}

type AssistantPart = Exclude<AssistantModelMessage["content"], string>[number];

function flattenPart(part: AssistantPart, toolNames: ReadonlySet<string>): AssistantPart {
  if (part.type === "tool-call" && toolNames.has(part.toolName)) {
    return { type: "text", text: `[${part.toolName} call] ${JSON.stringify(part.input)}` };
  }
  if (part.type === "tool-result" && toolNames.has(part.toolName)) {
    return { type: "text", text: describeToolResult(part) };
  }
  if (part.type !== "text") return part;
  const anthropic = part.providerOptions?.anthropic;
  if (anthropic === undefined || !("citations" in anthropic)) return part;
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      anthropic: Object.fromEntries(
        Object.entries(anthropic).filter(([key]) => key !== "citations"),
      ),
    },
  };
}

function describeToolResult(part: ToolResultPart): string {
  if (part.output.type.startsWith("error") || part.output.type === "execution-denied") {
    return `[${part.toolName} results] The call failed.`;
  }
  const sources = new Map<string, string | undefined>();
  collectSources(part.output, sources);
  if (sources.size === 0) return `[${part.toolName} results] No readable results.`;
  const lines = [...sources].map(([url, title]) => (title ? `- ${title}: ${url}` : `- ${url}`));
  return [`[${part.toolName} results]`, ...lines].join("\n");
}

function collectSources(value: unknown, out: Map<string, string | undefined>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSources(entry, out);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.url === "string" && !out.get(value.url)) {
    out.set(value.url, typeof value.title === "string" ? value.title : undefined);
  }
  for (const entry of Object.values(value)) collectSources(entry, out);
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
