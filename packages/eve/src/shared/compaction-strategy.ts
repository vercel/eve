import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

/**
 * Why eve compacts, named as the AI SDK names them. `automatic`: the strategy's trigger said the
 * history is due. `manual`: a client called `session.compact()`. `overflow`: the provider rejected
 * a step's request as longer than the model's context window; eve compacts, then retries the call
 * once.
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
  /** The most tokens the model writes in one response, from AI Gateway's model catalog. Absent when the catalog doesn't say. */
  readonly maxOutputTokens?: number;
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
  /**
   * With `prompt`, replaces the agent's instructions in the summary request. `""` sends none,
   * for a summarizer that works from a transcript of its own rather than the turn's prefix.
   */
  readonly system?: string;
}

/** What a compaction strategy reads, and the helpers it compacts with. */
export interface CompactionContext {
  readonly reason: CompactionReason;
  /** Where the trigger fired, or `manual`. */
  readonly phase: CompactionPhase | "manual";
  readonly session: { readonly id: string };
  /** The session model's limits, as the trigger's measure reports them. */
  readonly model: Pick<CompactionMeasure, "contextWindowTokens" | "maxOutputTokens">;
  /** The context change this compaction records, as `context.started` reports it. */
  readonly change: { readonly changeId: string };
  readonly tokens: {
    /**
     * The most history that fits the model's context window after instructions, tools, and
     * recall: what eve checks an automatic result against. Infinite when the window is unknown.
     */
    readonly limit: number;
    /** eve's estimate of `messages`, the one it checks an automatic result against. */
    estimate(messages: readonly StoredHistoryMessage[]): number;
  };
  /** Summarizes `messages`, billed to the change's summary run. */
  summarize(
    messages: readonly StoredHistoryMessage[],
    options?: CompactionSummaryOptions,
  ): Promise<string>;
  /**
   * The checkpoint head eve's own compaction recognizes, and reads the previous summary from, on
   * the next compaction. Put it first, followed by the history you keep. A summary that goes
   * elsewhere is a `context.compaction` user message of your own, such as
   * `{ role: "user", kind: "context.compaction", content: summary }`.
   */
  checkpoint(summary: string): StoredHistoryMessage[];
  readonly abortSignal: AbortSignal;
}

/**
 * Rewrites an agent's stored history when eve compacts it, and returns the history to keep.
 * `undefined` keeps the history as it is. eve checks the result: every user message keeps a kind,
 * every call keeps its result, a `ctx.checkpoint()` head opens the history if there is one, and an
 * automatic result fits within `ctx.tokens.limit`. What the model answers next is the strategy's:
 * keep the turn's input, or carry it in the summary.
 */
export type CompactionRewrite = (
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) =>
  | Promise<readonly StoredHistoryMessage[] | undefined>
  | readonly StoredHistoryMessage[]
  | undefined;

/** An agent's compaction strategy: a rewrite, or a rewrite with the trigger that runs it. */
export type CompactionStrategy =
  | CompactionRewrite
  | {
      readonly compact: CompactionRewrite;
      readonly when?: CompactionTrigger;
    };
