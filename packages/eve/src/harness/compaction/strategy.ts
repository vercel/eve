import type { ModelMessage } from "ai";

/**
 * What the core measured for the next model call. A strategy decides from
 * these numbers; it never reads session state.
 */
export interface CompactionFacts {
  /** Best count of the next request's input tokens, including the request envelope. */
  readonly inputTokens: number;
  /** The share of `inputTokens` that is not history: instructions, tool schemas. */
  readonly requestEnvelopeTokens: number;
  /** The most input tokens a request may carry before the history must be compacted. */
  readonly threshold: number;
  /** How many of the latest messages the session suggests keeping word for word. */
  readonly recentWindowSize: number;
  /** `manual` is a compaction the user asked for: it runs whatever `shouldCompact` says. */
  readonly reason: "manual" | "step";
}

export interface CompactionContext extends CompactionFacts {
  readonly abortSignal: AbortSignal;
  /** Estimates tokens the way the core measures the history. */
  estimateTokens(messages: readonly ModelMessage[]): number;
  /** Runs the compaction model over `messages`, billed to the session. */
  summarize(input: { readonly messages: ModelMessage[]; readonly system: string }): Promise<string>;
}

/**
 * A replacement history in two parts. The core puts memory records ahead of
 * both, so a strategy never sees or reorders them.
 */
export interface CompactedHistory {
  /** What replaces the compacted history: a summary, a marker, or nothing. */
  readonly checkpoint: readonly ModelMessage[];
  /** What stays word for word after the checkpoint. */
  readonly kept: readonly ModelMessage[];
}

/**
 * How a session's history is shortened. The core owns when compaction can
 * run, the events around it, memory records, failure and billing; a strategy
 * owns whether to compact and what the compacted history looks like.
 */
export interface CompactionStrategy {
  /**
   * Compacts `history` (the conversation, without memory records). Throws
   * `CompactionOverLimitError` when no history it could return fits.
   */
  compact(history: readonly ModelMessage[], context: CompactionContext): Promise<CompactedHistory>;
  shouldCompact(facts: CompactionFacts): boolean;
}
