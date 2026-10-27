import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";

/** Input tokens above which a settled turn asks for a compaction. */
export const BACKGROUND_COMPACTION_MIN_TOKENS = 8_000;

/**
 * The hook's decision: `turn.settled` asks for a compaction once the last model call's
 * input passed the floor. In `agent/hooks/compact.ts`:
 *
 *   "turn.settled"(_event, ctx) {
 *     if (shouldCompactInBackground(ctx.view.context.inputTokens)) ctx.compact();
 *   }
 *
 * The request is queued between turns, so the next turn's first model call compacts first.
 */
export function shouldCompactInBackground(
  inputTokens: number | undefined,
  minTokens = BACKGROUND_COMPACTION_MIN_TOKENS,
): boolean {
  return (inputTokens ?? 0) > minTokens;
}

/**
 * Summarizes the history after each turn instead of when a request overflows. A hook's
 * request arrives `forced`, below the limit; fixed-tail then summarizes all but the latest
 * message. Overflow compactions, which are not forced, keep the default behavior.
 */
export function backgroundCompaction(): CompactionStrategy {
  const base = fixedTail();
  return {
    compact: (history, context) =>
      context.forced && context.inputTokens <= BACKGROUND_COMPACTION_MIN_TOKENS
        ? Promise.resolve(history)
        : base.compact(history, context),
  };
}
