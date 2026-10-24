import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import {
  compactMessages,
  shouldCompact,
} from "#harness/compaction/strategies/fixed-tail/engine.js";
import { validateHarnessModelMessages } from "#harness/messages.js";

/**
 * The default strategy: when the history nears the context window, a summary
 * of everything but the latest conversation (at most 20,000 tokens, kept word
 * for word) replaces it.
 */
export function fixedTail(): CompactionStrategy {
  return {
    async compact(history, context) {
      const messages = await compactMessages(
        [...history],
        {
          recentWindowSize: context.recentWindowSize,
          threshold: Math.max(1, context.threshold - context.requestEnvelopeTokens),
        },
        context.summarize,
        context.reason === "manual",
        Math.max(0, context.inputTokens - context.requestEnvelopeTokens),
      );
      return validateHarnessModelMessages(messages);
    },
    shouldCompact,
  };
}
