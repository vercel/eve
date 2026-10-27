import type { LanguageModel, ModelMessage } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * A message a strategy returns. A user message needs a `kind`; build one with
 * `createCompactionUserMessage`.
 */
export type CompactionMessage = HarnessModelMessage;

export interface CompactionContext {
  /** Best count of the next request's input tokens, including the request envelope. */
  readonly inputTokens: number;
  /** The share of `inputTokens` that is not history: instructions, tool schemas, memory, client context. */
  readonly requestEnvelopeTokens: number;
  /** The most input tokens a request may carry before the history must be compacted. */
  readonly threshold: number;
  /** How many of the latest messages the session suggests keeping word for word. */
  readonly recentWindowSize: number;
  /** A user or a hook asked for this compaction; the context was not over its limit. */
  readonly forced: boolean;
  readonly abortSignal?: AbortSignal;
  /** Estimates tokens the way the core measures the history. */
  estimateTokens(messages: readonly ModelMessage[]): number;
  /**
   * Opens the session sandbox, for a strategy that moves content out of the history into files.
   * `null` when the session has no sandbox or it cannot be resumed.
   */
  openSandbox(): Promise<SandboxSession | null>;
  /** Runs the compaction model over `messages`, billed to the session. */
  summarize(input: {
    readonly messages: ModelMessage[];
    readonly system: string;
    /** A gateway model id or a language model for this call; the session's model when omitted. */
    readonly model?: string | LanguageModel;
  }): Promise<string>;
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
}
