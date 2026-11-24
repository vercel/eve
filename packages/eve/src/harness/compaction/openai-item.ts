import type { ModelMessage } from "ai";

import { isInjectedMessage } from "#harness/messages.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

export const OPENAI_DIRECT_PROVIDER = "openai.responses";

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

export function endsWithOpenAICompaction(history: readonly StoredHistoryMessage[]): boolean {
  return holdsItem(history.findLast((message) => !isInjectedMessage(message as ModelMessage)));
}
