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
 * The session event eve asks a strategy at. `model.requested`: once the turn's model is chosen,
 * before its call starts. `model.retried`: a failed attempt runs again in the same run, before the
 * retried call starts. `turn.settled`: after the turn's answer, before the turn settles, so a long
 * task isn't interrupted mid-turn. A manual compaction has no event and always runs the strategy.
 */
export type CompactionEvent = "model.requested" | "model.retried" | "turn.settled";

/** What a trigger reads to decide whether the history is due. */
export interface CompactionMeasure {
  /**
   * The next request's input tokens: the provider's count for the last request, plus eve's
   * estimate of what joined history since.
   */
  readonly inputTokens: number;
  /** The input tokens `compaction.threshold` allows. */
  readonly threshold: number;
  /** The model's context window, in tokens. Absent when eve doesn't know the model's window. */
  readonly contextWindowTokens?: number;
  /** The most tokens the model writes in one response, from AI Gateway's model catalog. Absent when the catalog doesn't say. */
  readonly maxOutputTokens?: number;
}

/**
 * When a strategy runs, keyed by the session event eve asks at. An entry is `true` to run when
 * the next request would pass the threshold, or a function that decides from the measure. A
 * strategy without `when` runs at `model.requested` over the threshold. An overflow compaction
 * runs after `model.retried` whatever `when` lists.
 */
export type CompactionTrigger = {
  readonly [Event in CompactionEvent]?: true | ((measure: CompactionMeasure) => boolean);
};

/** How `ctx.summarize` asks the model. */
export interface CompactionSummaryOptions {
  /** The model that writes the summary. Defaults to the turn's model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /**
   * Added to eve's checkpoint prompt, such as what the summary must keep word for word. Ignored
   * with `prompt`.
   */
  readonly instructions?: string;
  /**
   * Replaces eve's checkpoint prompt. The model then reads `messages` as the conversation, under
   * the agent's instructions, followed by one user message with this prompt. The request carries
   * no tools; `send()` sends the turn's own request with its tools.
   */
  readonly prompt?: string;
  /**
   * With `prompt`, replaces the agent's instructions in the summary request. `""` sends none,
   * for a summarizer that works from a transcript of its own rather than the turn's prefix.
   */
  readonly system?: string;
}

/** What a compaction strategy reads, and the helpers it compacts with. */
export interface CompactionContext {
  readonly reason: CompactionReason;
  /**
   * The event eve compacts at: the event the call last emitted, so `model.retried` for an
   * overflow compaction (it runs whatever `when` says, before the retried call), or `undefined`
   * for a manual one.
   */
  readonly event: CompactionEvent | undefined;
  readonly session: { readonly id: string };
  /**
   * The session model: the AI SDK's `provider` and `modelId` for it (`"openai.responses"` is
   * OpenAI's Responses API called directly, and a model routed through AI Gateway reports
   * `"gateway"`), and the limits the trigger's measure reports.
   */
  readonly model: Pick<CompactionMeasure, "contextWindowTokens" | "maxOutputTokens"> & {
    readonly provider: string;
    readonly modelId: string;
  };
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
   * Sends the turn's own request, with its instructions, tools and `history`, plus
   * `providerOptions`, and returns the assistant messages the model answers with, as stored
   * history. A message of kind `memory.load`, `context.instruction`, `context.state`,
   * `context.compaction` or `execution.retry` is left out of `history`: eve adds those fresh to
   * every request, so a provider that folds the request into a record it keeps would hold a stale
   * copy. The request goes through the turn's model, not the summary model, and counts as the
   * compaction's summary run.
   */
  send(
    history: readonly StoredHistoryMessage[],
    options: {
      readonly providerOptions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    },
  ): Promise<StoredHistoryMessage[]>;
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

export interface ResolvedCompactionStrategy {
  readonly compact: CompactionRewrite;
  readonly when: CompactionTrigger;
}
