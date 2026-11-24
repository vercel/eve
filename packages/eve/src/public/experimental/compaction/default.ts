import type { ModelMessage } from "ai";

import { createLogger } from "#internal/logging.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import { CompactionOverLimitError } from "#shared/compaction-over-limit-error.js";
import {
  type CompactionContext,
  type CompactionStrategy,
  DEFAULT_COMPACTION_THRESHOLD,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import {
  assertThreshold,
  belowThreshold,
  budgetAgainstWindow,
  budgetAt,
  type CompactionBudget,
  historyBudget,
} from "./budget.js";
import { COMPACTION_PROMPT_OVERHEAD_TOKENS } from "./checkpoint-prompt.js";
import {
  type CompactionStage,
  compactMessages,
  extractPreviousCheckpoint,
} from "./default-engine.js";

const log = createLogger("harness.compaction");

const RECENT_WINDOW_SIZE = 10;

function thresholdClearingTrigger(threshold: number): number {
  return Math.max(1, threshold - COMPACTION_PROMPT_OVERHEAD_TOKENS);
}

/** What `defaultCompaction()` can change. */
export interface DefaultCompactionOptions {
  /** The model that writes the summary, when it isn't the turn's model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** Added to eve's checkpoint prompt, such as what the summary must keep word for word. */
  readonly instructions?: string;
  /** The fraction of the context window at which it compacts. Defaults to 0.9. */
  readonly threshold?: number;
}

/**
 * eve's compaction when you configure none: it caps oversized tool results in older history, and
 * summarizes the older history if capping doesn't fit.
 *
 * ```ts
 * experimental: {
 *   compaction: defaultCompaction({
 *     model: "openai/gpt-5-mini",
 *     instructions: "Keep every ticket ID exactly as written.",
 *   }),
 * },
 * ```
 */
export function defaultCompaction(options: DefaultCompactionOptions = {}): CompactionStrategy {
  const fraction = options.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  assertThreshold(fraction);

  const compactWithin = async (
    history: readonly StoredHistoryMessage[],
    ctx: CompactionContext,
    budget: CompactionBudget,
  ): Promise<readonly StoredHistoryMessage[] | undefined> => {
    if (belowThreshold(ctx, budget.threshold, COMPACTION_PROMPT_OVERHEAD_TOKENS)) return undefined;
    const fitted = historyBudget(budget, ctx);
    const { messages } = await compactMessages(
      history as ModelMessage[],
      {
        estimate: (messages) => ctx.estimate(messages as StoredHistoryMessage[]),
        lastStage: ctx.recompacting && !ctx.requested ? stageOfPreviousResult(history) : undefined,
        recentWindowSize: RECENT_WINDOW_SIZE,
        target: fitted.target,
        threshold: thresholdClearingTrigger(fitted.threshold),
      },
      async (prompt) => {
        const { text } = await ctx.call({
          messages: prompt.messages as StoredHistoryMessage[],
          model: options.model,
          system:
            options.instructions === undefined
              ? prompt.system
              : `${prompt.system}\n\n${options.instructions}`,
        });
        if (text.trim().length === 0) {
          throw new Error("The compaction model returned an empty summary.");
        }
        return text;
      },
      ctx.requested,
      !ctx.requested,
    );
    return messages as StoredHistoryMessage[];
  };

  return async (history, ctx) => {
    const window = ctx.model.contextWindowTokens;
    const own = budgetAt(window, fraction);
    const scope = { sessionId: ctx.session.id };
    try {
      return await compactWithin(history, ctx, own);
    } catch (error) {
      if (!(error instanceof CompactionOverLimitError)) throw error;
      if (ctx.requested) throw error;
      if (window === undefined) {
        log.warn(
          `${error.message} eve doesn't know this model's context window, so it sends the request as it is. Set \`modelContextWindowTokens\` in \`agent.ts\` to compact against it.`,
          scope,
        );
        return undefined;
      }
      if (window > own.threshold) {
        log.warn(
          `${error.message} eve compacts against the model's ~${window}-token context window instead.`,
          scope,
        );
        try {
          return await compactWithin(history, ctx, budgetAgainstWindow(window));
        } catch (overWindow) {
          if (!(overWindow instanceof CompactionOverLimitError)) throw overWindow;
        }
      }
      throw new CompactionOverLimitError(
        `The agent's system prompt, tools, memory and context leave no room for the conversation in this model's ~${window}-token context window. Shorten the instructions, remove tools or trim memory.`,
      );
    }
  };
}

function stageOfPreviousResult(
  history: readonly StoredHistoryMessage[],
): CompactionStage | undefined {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(history as ModelMessage[]);
  if (previousCheckpoint === undefined) return undefined;
  return conversation.some((message) => message.role === "tool") ? "tail" : "text-tail";
}
