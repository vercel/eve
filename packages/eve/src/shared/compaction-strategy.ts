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

const COMPACTION_MODEL_COMPATIBILITY: unique symbol = Symbol.for(
  "eve.compaction-model-compatibility",
);

/** The provider and model id the AI SDK reports for a model. */
export interface CompactionModelIdentity {
  readonly provider: string;
  readonly modelId: string;
}

/**
 * The models a compaction strategy works with. `matches` runs when the model is built and on its
 * first call, and `acceptId` lets TypeScript check the strategy against the model id.
 */
export interface CompactionModelMatcher<TModelId extends string = string> {
  /** What the strategy needs, in the words of the error eve throws when the model doesn't match. */
  readonly description: string;
  readonly matches: (model: CompactionModelIdentity) => boolean;
  readonly acceptId?: (id: TModelId) => void;
}

/**
 * A compaction strategy, set on an agent or on a model selection as `experimental.compaction`.
 * eve asks it once before every model call (a retry after an empty response or a context-overflow
 * error included) and when a client calls `session.compact()`. When it throws or returns a history
 * eve rejects, eve runs the fallback strategy instead. It decides from `ctx` whether the history is due and returns the history to
 * keep, or `undefined` to keep it as it is. eve checks that every user message keeps a kind,
 * every call keeps its result, and the result fits within the model's context window.
 *
 * `TModelId` is the model ids the strategy works with. A strategy that names none accepts any model.
 */
export type CompactionStrategy<TModelId extends string = string> = ((
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) =>
  | Promise<readonly StoredHistoryMessage[] | undefined>
  | readonly StoredHistoryMessage[]
  | undefined) & {
  readonly [COMPACTION_MODEL_COMPATIBILITY]?: CompactionModelMatcher<TModelId>;
};

/**
 * A compaction strategy and the strategy eve runs when it fails. A strategy fails when it throws,
 * returns a history eve rejects, or keeps the history as it was after the provider rejected a
 * request as too long. Cancellation does not fail it.
 */
export interface ModelCompaction<TModelId extends string = never> {
  readonly strategy: CompactionStrategy<TModelId>;
  /** Defaults to `defaultCompaction()`. It decides for itself whether to compact, as every strategy does. */
  readonly fallback?: CompactionStrategy<TModelId>;
}

/** What `experimental.compaction` takes: a strategy, or a strategy with its fallback. */
export type ModelCompactionInput<TModelId extends string = never> =
  | CompactionStrategy<TModelId>
  | ModelCompaction<TModelId>;

export function modelCompaction<TModelId extends string>(
  compaction: ModelCompactionInput<TModelId>,
  field: string,
): ModelCompaction<TModelId> {
  const given = typeof compaction === "function" ? { strategy: compaction } : compaction;
  if (typeof given?.strategy !== "function") {
    throw new Error(
      `"${field}" must be a compaction strategy, or { strategy, fallback } with a strategy function.`,
    );
  }
  if (given.fallback !== undefined && typeof given.fallback !== "function") {
    throw new Error(`"${field}.fallback" must be a compaction strategy: a function.`);
  }
  return {
    strategy: given.strategy,
    ...(given.fallback !== undefined && { fallback: given.fallback }),
  };
}

export const MODEL_COMPACTION_CONFLICT =
  'A compaction strategy ("experimental.compaction") replaces the agent\'s "compaction" options. Move them to the strategy, such as defaultCompaction({ model, threshold }), and remove "compaction" from the agent.';

/** Returns a copy of the strategy that works only with the models `matcher` accepts. */
export function tagCompactionStrategy<TModelId extends string>(
  strategy: CompactionStrategy,
  matcher: CompactionModelMatcher<TModelId>,
): CompactionStrategy<TModelId> {
  const tagged: CompactionStrategy = (history, ctx) => strategy(history, ctx);
  Object.defineProperty(tagged, COMPACTION_MODEL_COMPATIBILITY, { value: matcher });
  return tagged as CompactionStrategy<TModelId>;
}

export function assertCompactionStrategyCompatible(
  compaction: ModelCompaction<never> | undefined,
  model: CompactionModelIdentity,
): void {
  for (const [role, strategy] of [
    ["strategy", compaction?.strategy],
    ["fallback", compaction?.fallback],
  ] as const) {
    const matcher = strategy?.[COMPACTION_MODEL_COMPATIBILITY];
    if (matcher === undefined || matcher.matches(model)) continue;
    throw new Error(
      `The compaction ${role} works with ${matcher.description}, but the model is ${model.provider} (${model.modelId}).`,
    );
  }
}

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
