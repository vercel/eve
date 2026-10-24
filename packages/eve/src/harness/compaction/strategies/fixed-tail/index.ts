import type { ModelMessage } from "ai";

import type { CompactedHistory, CompactionStrategy } from "#harness/compaction/strategy.js";
import {
  compactMessages,
  shouldCompact,
} from "#harness/compaction/strategies/fixed-tail/engine.js";
import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/strategies/fixed-tail/prompt.js";

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
      return splitCheckpoint(messages);
    },
    shouldCompact,
  };
}

/** The summary's marker and text lead the history when a summary replaced it. */
function splitCheckpoint(messages: readonly ModelMessage[]): CompactedHistory {
  const [marker] = messages;
  const hasCheckpoint =
    marker !== undefined &&
    marker.role === "user" &&
    marker.content === COMPACTION_CHECKPOINT_MARKER &&
    messages[1]?.role === "assistant";
  return hasCheckpoint
    ? { checkpoint: messages.slice(0, 2), kept: messages.slice(2) }
    : { checkpoint: [], kept: messages };
}
