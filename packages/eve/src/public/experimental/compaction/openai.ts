import { assertThreshold, belowThreshold, thresholdTokens } from "./budget.js";
import { withoutInjected } from "./injected.js";
import {
  awaitsReplyAfterOpenAICompaction,
  endsWithOpenAICompaction,
  readsOpenAICompaction,
} from "#shared/openai-compaction-item.js";
import {
  type CompactionStrategy,
  DEFAULT_COMPACTION_THRESHOLD,
  tagCompactionStrategy,
} from "#shared/compaction-strategy.js";

/** The AI Gateway ids `openaiCompaction()` works with. A model you build yourself is checked when it is created. */
export type OpenAICompactionModelId = `openai/${string}`;

/** What `openaiCompaction()` can change. */
export interface OpenAICompactionOptions {
  /** The fraction of the context window at which it compacts. Defaults to 0.9. */
  readonly threshold?: number;
}

/**
 * Compacts with OpenAI's own compaction instead of a text summary. OpenAI answers the turn's
 * request with an encrypted record of the history. eve stores the record, followed by the turn's
 * latest user message, as the history and sends both with every later request. It works with `openai("gpt-...")` and with `"openai/gpt-..."` through AI
 * Gateway, which eve pins to OpenAI while the record is in the history. Set on an agent or model
 * selection that uses another model, it fails the build, the type check or the model's first call.
 *
 * When the call fails, or the answer holds no compaction record, eve runs the strategy's
 * `fallback`, which is `defaultCompaction()` unless you set one. That text summary keeps the
 * earlier records and summarizes only what follows them.
 *
 * ```ts
 * defineAgent({
 *   model: "openai/gpt-5",
 *   experimental: { compaction: openaiCompaction({ threshold: 0.8 }) },
 * })
 * ```
 */
export function openaiCompaction(
  options: OpenAICompactionOptions = {},
): CompactionStrategy<OpenAICompactionModelId> {
  const fraction = options.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  assertThreshold(fraction);
  const strategy: CompactionStrategy = async (history, ctx) => {
    if (belowThreshold(ctx, thresholdTokens(ctx.model.contextWindowTokens, fraction))) {
      return undefined;
    }
    if (awaitsReplyAfterOpenAICompaction(history)) return undefined;
    const { messages: compacted } = await ctx.call({
      messages: history,
      providerOptions: {
        openai: { compactionTrigger: true },
        ...(ctx.model.provider === "gateway" && { gateway: { only: ["openai"] } }),
      },
      tools: "inherit",
    });
    if (!endsWithOpenAICompaction(compacted)) {
      throw new Error(
        `${ctx.model.provider} ${ctx.model.modelId} answered the compaction request without a compaction record.`,
      );
    }
    const candidates = withoutInjected(history).filter((message) => message.role === "user");
    const latest = candidates.findLast((message) => message.kind === "user") ?? candidates.at(-1);
    return latest === undefined ? compacted : [...compacted, latest];
  };
  return tagCompactionStrategy<OpenAICompactionModelId>(strategy, {
    acceptId: () => {},
    description: 'an OpenAI Responses model (openai("...") or "openai/..." on AI Gateway)',
    matches: readsOpenAICompaction,
  });
}
