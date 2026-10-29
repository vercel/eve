import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { HistoryMessage } from "#shared/history-message.js";

/**
 * Why eve compacts, named as the AI SDK names them. `automatic`: the next request is over the
 * limit `compaction.threshold` sets. `manual`: a client called `session.compact()`. `overflow` is
 * reserved for compacting after a provider rejects a request as too long; eve doesn't send it yet.
 */
export type CompactionReason = "automatic" | "manual" | "overflow";

/** What a compaction strategy reads, and the helpers it compacts with. */
export interface CompactionContext {
  readonly reason: CompactionReason;
  readonly session: { readonly id: string };
  /** The context change this compaction records, as `context.started` reports it. */
  readonly change: { readonly changeId: string };
  readonly tokens: {
    /** The most history that fits under the limit, after instructions, tools, and recall. */
    readonly limit: number;
    /** eve's estimate of `messages`, the one it checks an automatic result against. */
    estimate(messages: readonly HistoryMessage[]): number;
  };
  /**
   * Summarizes `messages` with eve's checkpoint prompt, billed to the change's summary run.
   * `model` defaults to the turn model; `instructions` extend eve's prompt.
   */
  summarize(
    messages: readonly HistoryMessage[],
    options?: {
      readonly instructions?: string;
      readonly model?: PublicAgentStaticModelDefinition;
    },
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
 * `undefined` means nothing can be removed. eve checks the result: every call keeps its result,
 * a checkpoint opens the history, the turn's input survives, and an automatic result fits within
 * `ctx.tokens.limit`.
 */
export type CompactionStrategy = (
  history: readonly HistoryMessage[],
  ctx: CompactionContext,
) => Promise<readonly HistoryMessage[] | undefined> | readonly HistoryMessage[] | undefined;
