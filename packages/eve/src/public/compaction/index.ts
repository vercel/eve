export { openaiCompaction } from "./openai.js";
export { fixedTail, turns } from "./strategies.js";
export { CompactionOverflowError } from "#harness/compaction/overflow-error.js";
export type { FixedTailOptions } from "#harness/compaction/authored.js";
export type {
  CompactionContext,
  CompactionEvent,
  CompactionMeasure,
  CompactionReason,
  CompactionRewrite,
  CompactionStrategy,
  CompactionSummaryOptions,
  CompactionTrigger,
} from "#shared/compaction-strategy.js";
export type { HistoryMessageKind, StoredHistoryMessage } from "#shared/history-message.js";
