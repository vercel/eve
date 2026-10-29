import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonValue } from "#shared/json.js";

/** The turn eve's native loop is about to settle, as `beforeSettle` reads it. */
export interface SettlingTurn {
  /** The reply the turn would settle with: its prose, or the structured value it delivered. */
  readonly output: JsonValue;
  /** The session's history, including this turn's response. */
  readonly history: readonly HistoryMessage[];
  /** How many times `beforeSettle` continued this turn. */
  readonly continuations: number;
}

/** What a loop stage knows about where it runs. */
export interface LoopStageContext {
  readonly session: { readonly id: string };
  readonly turn: { readonly id: string };
  /** Aborts when the turn is cancelled. */
  readonly signal?: AbortSignal;
}

/** Sends the model `note` and runs it again in the same turn, instead of settling. */
export interface BeforeSettleContinue {
  readonly continue: { readonly note: string };
}

/**
 * Runs when the native loop would settle a turn as completed. Return `undefined` to settle, or
 * `{ continue: { note } }` to show the model the note and run it again in the same turn.
 */
export type BeforeSettle = (
  turn: SettlingTurn,
  ctx: LoopStageContext,
) => BeforeSettleContinue | undefined | Promise<BeforeSettleContinue | undefined>;

/**
 * Experimental stages that change one decision of eve's native loop. Unstable: the shape can
 * change in a patch release.
 */
export interface AgentLoopDefinition {
  readonly beforeSettle?: BeforeSettle;
  /**
   * How many times `beforeSettle` can continue one turn. At the cap, eve settles without calling
   * it.
   *
   * @default 3
   */
  readonly maxContinuations?: number;
}

/** Compiled `experimental.loop`: the manifest marks the stage, which the runtime loads. */
export interface CompiledAgentLoopDefinition {
  readonly beforeSettle?: boolean;
  readonly maxContinuations?: number;
}

export const DEFAULT_MAX_CONTINUATIONS = 3;
export const MAX_CONTINUATIONS_LIMIT = 10;
