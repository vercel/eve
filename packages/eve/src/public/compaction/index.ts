import type { ExactDefinition } from "#public/definitions/exact.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { COMPACTION_DEFINITION_BRAND } from "#shared/compaction-definition.js";

export type {
  CompactionMessage,
  CompactionContext,
  CompactionStrategy,
} from "#harness/compaction/strategy.js";
export type { HarnessModelMessage } from "#harness/messages.js";
export { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
export { createCompactionUserMessage } from "#harness/compaction/message.js";
export { referenceCompaction } from "#harness/compaction/strategies/reference/index.js";
export { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";
export type { FixedTailOptions } from "#harness/compaction/strategies/fixed-tail/index.js";

export type DefinedCompaction<T extends CompactionStrategy = CompactionStrategy> = T & {
  readonly [COMPACTION_DEFINITION_BRAND]: true;
};

/** Declares the agent's compaction strategy in `compaction.ts`. */
export function defineCompaction<const T extends CompactionStrategy>(
  strategy: ExactDefinition<T, CompactionStrategy>,
): DefinedCompaction<T>;
export function defineCompaction(strategy: CompactionStrategy): DefinedCompaction {
  Object.assign(strategy, { [COMPACTION_DEFINITION_BRAND]: true });
  return strategy as DefinedCompaction;
}
