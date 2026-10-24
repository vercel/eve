import { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";

/** What an agent without a `compaction.ts` runs. */
export const defaultCompactionStrategy: CompactionStrategy = fixedTail();
