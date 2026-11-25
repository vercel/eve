import { assertThreshold, belowThreshold, thresholdTokens } from "./budget.js";
import { defaultCompaction } from "./default.js";
import { withoutInjected } from "./injected.js";
import {
  endsWithOpenAICompaction,
  holdsOpenAICompaction,
  readsOpenAICompaction,
} from "#shared/openai-compaction-item.js";
import { createLogger } from "#internal/logging.js";
import {
  type CompactionStrategy,
  DEFAULT_COMPACTION_THRESHOLD,
} from "#shared/compaction-strategy.js";

const log = createLogger("harness.compaction");

/** What `openaiCompaction()` can change. */
export interface OpenAICompactionOptions {
  /**
   * Compacts when OpenAI's compaction can't: another provider's model, or a failed call. It decides
   * for itself whether to compact, as every strategy does. Defaults to `defaultCompaction()` with
   * this `threshold`.
   */
  readonly fallback?: CompactionStrategy;
  /** The fraction of the context window at which it compacts. Defaults to 0.9. */
  readonly threshold?: number;
}

/**
 * Compacts with OpenAI's own compaction instead of a text summary. OpenAI answers the turn's
 * request with an encrypted record of the history, which eve stores as the history and sends with
 * every later request. It works with `openai("gpt-...")` and with `"openai/gpt-..."` through AI
 * Gateway, which eve pins to OpenAI while the record is in the history. Another model, a failed
 * call, or an answer without a record compacts with `fallback`.
 *
 * ```ts
 * experimental: { compaction: openaiCompaction({ threshold: 0.8 }) },
 * ```
 */
export function openaiCompaction(options: OpenAICompactionOptions = {}): CompactionStrategy {
  const fraction = options.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  assertThreshold(fraction);
  const fallback = options.fallback ?? defaultCompaction({ threshold: fraction });
  return async (history, ctx) => {
    if (!readsOpenAICompaction(ctx.model)) {
      const compacted = await fallback(history, ctx);
      if (compacted !== undefined) {
        log.warn(
          `openaiCompaction() needs an OpenAI model, called directly or as an "openai/" AI Gateway string; the model is ${ctx.model.provider} ${ctx.model.modelId}, so eve compacted with its fallback instead.`,
          { sessionId: ctx.session.id },
        );
      }
      return compacted;
    }
    if (belowThreshold(ctx, thresholdTokens(ctx.model.contextWindowTokens, fraction))) {
      return undefined;
    }
    const sendable = withoutInjected(history);
    if (endsWithOpenAICompaction(sendable)) return undefined;
    const holdsRecord = holdsOpenAICompaction(sendable);
    const instead = holdsRecord
      ? "keeps the history, because a text summary would drop its earlier compaction record"
      : "compacts with its fallback instead";
    const otherwise = async () => (holdsRecord ? undefined : await fallback(history, ctx));
    let compacted: Awaited<ReturnType<typeof ctx.call>>["messages"];
    try {
      ({ messages: compacted } = await ctx.call({
        messages: sendable,
        providerOptions: {
          openai: { compactionTrigger: true },
          ...(ctx.model.provider === "gateway" && { gateway: { only: ["openai"] } }),
        },
        tools: "inherit",
      }));
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      log.error(`OpenAI compaction failed; eve ${instead}`, {
        ...failureClass(error),
        sessionId: ctx.session.id,
      });
      return await otherwise();
    }
    if (endsWithOpenAICompaction(compacted)) return compacted;
    log.warn(
      `${ctx.model.provider} ${ctx.model.modelId} answered the compaction request without a compaction record, so eve ${instead}.`,
      { sessionId: ctx.session.id },
    );
    return await otherwise();
  };
}

function failureClass(error: unknown): { errorName: string; statusCode?: number } {
  const statusCode = error instanceof Error ? Reflect.get(error, "statusCode") : undefined;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof statusCode === "number" && { statusCode }),
  };
}
