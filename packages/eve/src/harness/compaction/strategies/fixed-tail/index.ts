import type { LanguageModel } from "ai";

import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { compactMessages } from "#harness/compaction/strategies/fixed-tail/engine.js";
import { COMPACTION_DEFINITION_BRAND } from "#shared/compaction-definition.js";
import { validateHarnessModelMessages } from "#harness/messages.js";

export interface FixedTailOptions {
  /** The model that writes the summary: a gateway model id or a language model. The session's model by default. */
  readonly model?: string | LanguageModel;
  /** How many tokens of the latest conversation stay word for word. 20,000 by default, and at most half the compaction limit. */
  readonly recentTokens?: number;
}

function expectPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`fixedTail: "${name}" must be a positive integer, got ${value}.`);
  }
}

/**
 * The default strategy: when the history nears the context window, a summary
 * of everything but the latest conversation (`recentTokens`, 20,000 by default,
 * kept word for word) replaces it.
 */
export function fixedTail(options: FixedTailOptions = {}): CompactionStrategy {
  const { model, recentTokens } = options;
  expectPositiveInteger("recentTokens", recentTokens);
  const strategy: CompactionStrategy = {
    async compact(history, context) {
      const messages = await compactMessages(
        [...history],
        {
          recentWindowSize: context.recentWindowSize,
          ...(recentTokens !== undefined && { recentTokens }),
          threshold: Math.max(1, context.threshold - context.requestEnvelopeTokens),
        },
        (prompt) => context.summarize({ ...prompt, model }),
        context.forced,
        Math.max(0, context.inputTokens - context.requestEnvelopeTokens),
      );
      return validateHarnessModelMessages(messages);
    },
  };
  return Object.assign(strategy, { [COMPACTION_DEFINITION_BRAND]: true });
}
