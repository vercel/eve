import { fixedTailOf, type FixedTailOptions } from "#harness/compaction/authored.js";
import type { CompactionStrategy } from "#shared/compaction-strategy.js";
import type { HistoryMessage } from "#shared/history-message.js";

/**
 * eve's default strategy. It caps oversized tool results in older history, with no model call,
 * and summarizes the older history only if capping doesn't fit. A manual compaction goes straight
 * to summarizing. Wrap it to keep part of the history out of its reach.
 *
 * ```ts
 * compaction: {
 *   compact: fixedTail({
 *     model: "openai/gpt-5-mini",
 *     instructions: "Keep every ticket ID exactly as written.",
 *   }),
 * },
 * ```
 */
export function fixedTail(options: FixedTailOptions = {}): CompactionStrategy {
  return async (history, ctx) => {
    const run = fixedTailOf(ctx);
    if (run === undefined) {
      throw new Error(
        "fixedTail() runs inside eve's compaction: call it with the context eve passes the strategy.",
      );
    }
    return await run(history, options);
  };
}

/**
 * The history in whole turns. A turn starts at a person's message, with the framework messages
 * just ahead of it, and never splits a tool call from its result, so a strategy that drops or
 * summarizes whole turns keeps every exchange intact. A checkpoint head is its own first turn.
 */
export function turns(history: readonly HistoryMessage[]): HistoryMessage[][] {
  const groups: HistoryMessage[][] = [];
  let current: HistoryMessage[] = [];
  let leading: HistoryMessage[] = [];
  const open = new Set<string>();
  for (const message of history) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call") open.add(part.toolCallId);
        if (part.type === "tool-result") open.delete(part.toolCallId);
      }
    }
    if (message.role !== "user" || open.size > 0) {
      current.push(...leading, message);
      leading = [];
      continue;
    }
    const kind = (message as { readonly kind?: unknown }).kind;
    if (kind === "user" || kind === "task.result") {
      if (current.length > 0) groups.push(current);
      current = [...leading, message];
      leading = [];
    } else if (kind === "context.compaction" && groups.length === 0 && current.length === 0) {
      current.push(message);
    } else {
      leading.push(message);
    }
  }
  current.push(...leading);
  if (current.length > 0) groups.push(current);
  return groups;
}
