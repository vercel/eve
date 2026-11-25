import type { StoredHistoryMessage } from "#shared/history-message.js";
import type { JsonObject } from "#shared/json.js";

const OPENAI_DIRECT_PROVIDER = "openai.responses";
const GATEWAY_PROVIDER = "gateway";

const OPENAI_COMPACTION_KIND = "openai.compaction";

function isCompactionItem(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "custom" &&
    (part as { kind?: unknown }).kind === OPENAI_COMPACTION_KIND
  );
}

function holdsItem(message: StoredHistoryMessage | undefined): boolean {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(isCompactionItem)
  );
}

export function holdsOpenAICompaction(history: readonly StoredHistoryMessage[]): boolean {
  return history.some(holdsItem);
}

export function readsOpenAICompaction(model: {
  readonly provider: string;
  readonly modelId: string;
}): boolean {
  return (
    model.provider === OPENAI_DIRECT_PROVIDER ||
    (model.provider === GATEWAY_PROVIDER && model.modelId.startsWith("openai/"))
  );
}

export function endsWithOpenAICompaction(history: readonly StoredHistoryMessage[]): boolean {
  return holdsItem(history.at(-1));
}

export function pinnedToOpenAI(
  providerOptions: Record<string, JsonObject> | undefined,
): Record<string, JsonObject> {
  const gateway = providerOptions?.gateway;
  if (gateway?.only !== undefined) return providerOptions ?? {};
  return { ...providerOptions, gateway: { ...gateway, only: ["openai"] } };
}

export function withoutOpenAICompaction<
  Message extends { readonly role: string; readonly content: unknown },
>(messages: readonly Message[]): Message[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const kept = message.content.filter((part) => !isCompactionItem(part));
    if (kept.length === message.content.length) return [message];
    return kept.length === 0 ? [] : [{ ...message, content: kept }];
  });
}
