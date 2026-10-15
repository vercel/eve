import { z } from "#compiled/zod/index.js";

import { cause, conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Cause, Envelope, ErrorInfo } from "../envelope.js";
import type { TraceContext } from "./session.js";

export interface TurnStartedData {
  readonly turnId: string;
  readonly cause: Cause;
  /** The turn whose context this one continues; `null` after a clear, or for the first turn. */
  readonly follows: string | null;
  readonly trace?: TraceContext;
}

/**
 * The turn waits on people: the interactions only they can settle. The session announces it in
 * the commit that leaves the turn so, and again when someone new is asked. A reader following
 * the stream from a cursor stops here without folding what came before; one that folds reads
 * the same from `waiting(view, turnId)`. Nothing announces the turn going on: its next model run
 * or consumed delivery shows it.
 */
export interface TurnPausedData {
  readonly turnId: string;
  readonly awaiting: readonly { readonly interactionId: string }[];
}

export type TurnOutcome = "completed" | "failed" | "cancelled";

export interface TurnSettledData {
  readonly turnId: string;
  readonly outcome: TurnOutcome;
  /** The content parts that answer the turn: its reply text, structured result, or files. */
  readonly reply?: readonly string[];
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
}

export type TurnStarted = Envelope<"turn.started", TurnStartedData>;
export type TurnSettled = Envelope<"turn.settled", TurnSettledData>;
export type TurnPaused = Envelope<"turn.paused", TurnPausedData>;
export type TurnFact = TurnStarted | TurnPaused | TurnSettled;

export const turnSchemas = {
  "turn.paused": envelopeOf(
    "turn.paused",
    conforming<TurnPausedData>()(
      z.object({ awaiting: z.array(z.object({ interactionId: id })), turnId: id }),
    ),
  ),
  "turn.settled": envelopeOf(
    "turn.settled",
    conforming<TurnSettledData>()(
      z.object({
        cause: cause.optional(),
        error: errorInfo.optional(),
        outcome: known<TurnOutcome>(),
        reply: z.array(id).optional(),
        turnId: id,
      }),
    ),
  ),
  "turn.started": envelopeOf(
    "turn.started",
    conforming<TurnStartedData>()(
      z.object({
        cause,
        follows: id.nullable(),
        trace: z
          .object({ spanId: z.string(), traceFlags: z.number().int(), traceId: z.string() })
          .optional(),
        turnId: id,
      }),
    ),
  ),
};
