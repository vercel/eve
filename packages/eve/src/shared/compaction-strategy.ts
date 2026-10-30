import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { HistoryMessage } from "#shared/history-message.js";

/**
 * Why eve compacts, named as the AI SDK names them. `automatic`: the strategy's trigger said the
 * history is due. `manual`: a client called `session.compact()`. `overflow` is reserved for
 * compacting after a provider rejects a request as too long; eve doesn't send it yet.
 */
export type CompactionReason = "automatic" | "manual" | "overflow";

/**
 * Where eve asks a strategy's trigger whether the history is due. `step`: before a model call.
 * `turn-end`: after the turn's answer, before the turn settles, so a long task isn't
 * interrupted mid-turn. A manual compaction always runs the strategy.
 */
export type CompactionPhase = "step" | "turn-end";

/** What a trigger reads to decide whether the history is due. */
export interface CompactionMeasure {
  readonly phase: CompactionPhase;
  /**
   * The next request's input tokens: the provider's count for the last request, plus eve's
   * estimate of what joined history since.
   */
  readonly inputTokens: number;
  /** The input tokens `compaction.threshold` allows. */
  readonly threshold: number;
  /** The model's context window, in tokens. */
  readonly contextWindowTokens: number;
}

/** When a strategy runs. A strategy without one runs before a model call over the threshold. */
export interface CompactionTrigger {
  /** Where eve asks `due`. Defaults to `["step"]`. */
  readonly phases?: readonly CompactionPhase[];
  /** Whether the history is due. Defaults to `inputTokens > threshold`. */
  readonly due?: (measure: CompactionMeasure) => boolean;
}

/** How `ctx.summarize` asks the model. */
export interface CompactionSummaryOptions {
  /** The model that writes the summary. Defaults to the agent's compaction model, or the turn's. */
  readonly model?: PublicAgentStaticModelDefinition;
  /**
   * Added to eve's checkpoint prompt, such as what the summary must keep word for word. Ignored
   * with `prompt`.
   */
  readonly instructions?: string;
  /**
   * Replaces eve's checkpoint prompt. The model then reads `messages` as the conversation, under
   * the agent's instructions, followed by one user message with this prompt: the request starts
   * as the turn's did, so a provider can serve it from the turn's prompt cache.
   */
  readonly prompt?: string;
  /**
   * With `prompt`, also send the turn's tools (the model can't call them), so the summary request
   * shares the turn's whole cached prefix. Only a compaction before a model call has the turn's
   * tools; elsewhere the request goes without them.
   */
  readonly reusePrefix?: boolean;
}

/** What a compaction strategy reads, and the helpers it compacts with. */
export interface CompactionContext {
  readonly reason: CompactionReason;
  /** Where the trigger fired, or `manual`. */
  readonly phase: CompactionPhase | "manual";
  readonly session: { readonly id: string };
  /** The context change this compaction records, as `context.started` reports it. */
  readonly change: { readonly changeId: string };
  readonly tokens: {
    /** The most history that fits under the threshold, after instructions, tools, and recall. */
    readonly limit: number;
    /** eve's estimate of `messages`, the one it checks an automatic result against. */
    estimate(messages: readonly HistoryMessage[]): number;
  };
  /** Summarizes `messages`, billed to the change's summary run. */
  summarize(
    messages: readonly HistoryMessage[],
    options?: CompactionSummaryOptions,
  ): Promise<string>;
  /**
   * The checkpoint head eve recognizes on the next compaction. Put it first, followed by the
   * history you keep.
   */
  checkpoint(summary: string): HistoryMessage[];
  readonly abortSignal: AbortSignal;
}

/**
 * Rewrites an agent's stored history when eve compacts it, and returns the history to keep.
 * `undefined` keeps the history as it is. eve checks the result: every call keeps its result, a
 * checkpoint opens the history, the turn's input survives, and an automatic result fits within
 * `ctx.tokens.limit`.
 */
export type CompactionRewrite = (
  history: readonly HistoryMessage[],
  ctx: CompactionContext,
) => Promise<readonly HistoryMessage[] | undefined> | readonly HistoryMessage[] | undefined;

/** An agent's compaction strategy: a rewrite, or a rewrite with the trigger that runs it. */
export type CompactionStrategy =
  | CompactionRewrite
  | {
      readonly compact: CompactionRewrite;
      readonly when?: CompactionTrigger;
    };
