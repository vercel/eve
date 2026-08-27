import type { LanguageModel, ModelMessage } from "ai";

/**
 * Removes reasoning that OpenAI Responses cannot replay from the wire request.
 *
 * The canonical history remains untouched so a later provider switch can still
 * reuse that provider's signed reasoning. OpenAI-native reasoning is retained
 * when it carries either a stored item id or stateless encrypted content.
 */
export function normalizeProviderReasoningHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly model: LanguageModel;
}): ModelMessage[] {
  const target = resolveOpenAIResponsesTarget(input.model);
  if (target === undefined) {
    return [...input.messages];
  }

  return input.messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }

    const content = message.content.filter(
      (part) =>
        part.type !== "reasoning" || hasReplayableOpenAIReasoning(part.providerOptions, target),
    );
    if (content.length === 0) return [];
    return content.length === message.content.length ? [message] : [{ ...message, content }];
  });
}

interface OpenAIResponsesTarget {
  readonly providerOptionsName: "azure" | "openai";
  readonly supportsStoredItems: boolean;
}

function resolveOpenAIResponsesTarget(model: LanguageModel): OpenAIResponsesTarget | undefined {
  if (typeof model === "string") {
    return model.startsWith("openai/")
      ? { providerOptionsName: "openai", supportsStoredItems: true }
      : undefined;
  }
  if (typeof model.provider !== "string" || typeof model.modelId !== "string") {
    return undefined;
  }

  if (model.provider === "gateway.language-model") {
    return model.modelId.startsWith("openai/")
      ? { providerOptionsName: "openai", supportsStoredItems: true }
      : undefined;
  }

  switch (model.provider) {
    case "azure.responses":
      return { providerOptionsName: "azure", supportsStoredItems: true };
    case "codex.responses":
      return { providerOptionsName: "openai", supportsStoredItems: false };
    case "openai.responses":
      return { providerOptionsName: "openai", supportsStoredItems: true };
    default:
      return undefined;
  }
}

function hasReplayableOpenAIReasoning(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  target: OpenAIResponsesTarget,
): boolean {
  const options = providerOptions?.[target.providerOptionsName];
  return (
    (target.supportsStoredItems && hasNonEmptyString(options?.itemId)) ||
    hasNonEmptyString(options?.reasoningEncryptedContent)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
