import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

export const DEFAULT_COMPACTION_THRESHOLD = 0.9;

/** A model call a strategy makes through `ctx.call()`. */
export interface CompactionCallRequest {
  /** Exactly what the model reads: eve adds no recalled memory, client context or announcements. */
  readonly messages: readonly StoredHistoryMessage[];
  /** The model to call. Defaults to the turn's model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** The system prompt. Defaults to the turn's instructions. */
  readonly system?: string;
  /** `"inherit"` sends the turn's own tools, which the model can call but eve never runs. Defaults to `"none"`. */
  readonly tools?: "inherit" | "none";
  /** Provider options for this call, merged over the turn's. */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** What `ctx.call()` returns: the assistant messages the model answered with, and their text. */
export interface CompactionCallResult {
  readonly messages: StoredHistoryMessage[];
  readonly text: string;
}

/** What a compaction strategy reads, and the one model call it makes. */
export interface CompactionContext {
  /** `true` only when a client called `session.compact()`: compact whatever the size. */
  readonly requested: boolean;
  /**
   * `true` only on the retry after the provider rejected a request as longer than the model's
   * context window: compact whatever the size. Never `true` together with `requested`.
   */
  readonly overflow: boolean;
  /**
   * The next request's input tokens: the provider's count for the last request, plus eve's
   * estimate of what joined history since. Instructions, tools and recalled memory are included.
   */
  readonly tokens: number;
  /**
   * The tokens in the next request outside the history: instructions, tools and recalled memory,
   * in `estimate()` units.
   */
  readonly fixedTokens: number;
  /** The measured ratio of the provider's token count to `estimate()`. 1.6 until eve has measured one. */
  readonly estimateRatio: number;
  readonly session: { readonly id: string };
  /**
   * The session model: the AI SDK's `provider` and `modelId` (`"openai.responses"` for OpenAI's
   * Responses API called directly, `"gateway"` for a model routed through AI Gateway), and its
   * limits.
   */
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    /** The model's context window, in tokens. Absent when eve doesn't know the model's window. */
    readonly contextWindowTokens?: number;
    /** The most tokens the model writes in one response, from AI Gateway's model catalog. Absent when the catalog doesn't say. */
    readonly maxOutputTokens?: number;
  };
  /**
   * `true` when the previous rewrite did not hold for one response, so the history is due again.
   * A strategy with a gentler and a harsher rewrite starts at the harsher one.
   */
  readonly recompacting: boolean;
  /** eve's estimate of a message's tokens: a quarter of its serialized bytes, plus media. Not the provider's count. */
  estimate(messages: readonly StoredHistoryMessage[]): number;
  /**
   * Calls a model and returns what it answered. eve bills its usage to the compaction, and a
   * request longer than the model's context window throws `CompactionOverflowError`.
   */
  call(request: CompactionCallRequest): Promise<CompactionCallResult>;
  readonly abortSignal: AbortSignal;
}

/**
 * An agent's compaction strategy. eve asks it once before every model call (a retry after an
 * empty response or a context-overflow error included) and when a client calls
 * `session.compact()`. It decides from `ctx` whether the history is due and returns the history to
 * keep, or `undefined` to keep it as it is. eve checks that every user message keeps a kind,
 * every call keeps its result, and the result fits within the model's context window.
 */
export type CompactionStrategy = (
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) =>
  | Promise<readonly StoredHistoryMessage[] | undefined>
  | readonly StoredHistoryMessage[]
  | undefined;

/**
 * A summary or provider request was longer than the model's context window. A strategy can catch
 * it from `ctx.call()`, drop part of what it sent, and call again.
 */
export class CompactionOverflowError extends Error {
  override readonly name = "CompactionOverflowError";

  constructor(options: { readonly cause: unknown }) {
    super("The compaction request is longer than the model's context window.", options);
  }
}
