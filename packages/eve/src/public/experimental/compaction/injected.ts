import type { HistoryMessageKind, StoredHistoryMessage } from "#shared/history-message.js";

const INJECTED_KINDS: ReadonlySet<HistoryMessageKind> = new Set([
  "memory.load",
  "context.instruction",
  "context.state",
  "context.compaction",
  "execution.retry",
]);

/**
 * The history without the messages eve adds to every request (memory, injected context, the
 * compaction checkpoint, retry notes), which a provider that keeps the request would hold stale.
 */
export function withoutInjected(history: readonly StoredHistoryMessage[]): StoredHistoryMessage[] {
  return history.filter((message) => message.role !== "user" || !INJECTED_KINDS.has(message.kind));
}
