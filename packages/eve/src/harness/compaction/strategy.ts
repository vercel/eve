import type { ModelMessage } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";

/**
 * A message a strategy returns. A user message needs a `kind`; build one with
 * `createCompactionUserMessage`.
 */
export type CompactionMessage = HarnessModelMessage;

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
  readonly abortSignal?: AbortSignal;
  /** Estimates tokens the way the core measures the history. */
  estimateTokens(messages: readonly ModelMessage[]): number;
  /** Runs the compaction model over `messages`, billed to the session. */
  summarize(input: { readonly messages: ModelMessage[]; readonly system: string }): Promise<string>;
}

/**
 * How a session's history is shortened. The core owns when compaction can
 * run, the events around it, memory records, failure and billing; a strategy
 * owns whether to compact and what the compacted history looks like.
 */
export interface CompactionStrategy {
  /**
   * Returns the replacement for `history` (the conversation, without memory
   * records, which eve places ahead of the result). Throws
   * `CompactionOverLimitError` when no history it could return fits.
   */
  compact(
    history: readonly CompactionMessage[],
    context: CompactionContext,
  ): Promise<readonly CompactionMessage[]>;
  shouldCompact(facts: CompactionFacts): boolean;
}
