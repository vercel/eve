/**
 * Compaction strategies for an agent's `compaction.compact`, and the helpers eve's own default
 * is built with.
 */

export { fixedTail, turns } from "./strategies.js";
export { CompactionOverflowError } from "#harness/compaction/overflow-error.js";
export type { FixedTailOptions } from "#harness/compaction/authored.js";
export type {
  CompactionContext,
  CompactionMeasure,
  CompactionPhase,
  CompactionReason,
  CompactionRewrite,
  CompactionStrategy,
  CompactionSummaryOptions,
  CompactionTrigger,
} from "#shared/compaction-strategy.js";
export type { HistoryMessageKind, StoredHistoryMessage } from "#shared/history-message.js";
