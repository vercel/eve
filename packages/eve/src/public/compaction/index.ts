/**
 * Compaction strategies for an agent's `compaction.compact`, and the helpers eve's own default
 * is built with.
 */

export { fixedTail, turns } from "./strategies.js";
export type { FixedTailOptions } from "#harness/compaction/authored.js";
export type {
  CompactionContext,
  CompactionReason,
  CompactionStrategy,
} from "#shared/compaction-strategy.js";
