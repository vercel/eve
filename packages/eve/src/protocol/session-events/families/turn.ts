import { z } from "#compiled/zod/index.js";

import { TURN_OUTCOMES } from "../catalog.js";
import { cause, conforming, envelopeOf, errorInfo, id } from "../common.js";
import type { Cause, Envelope, ErrorInfo } from "../envelope.js";
import type { TraceContext } from "./session.js";

export interface TurnStartedData {
  readonly turnId: string;
  readonly cause: Cause;
  /** The turn whose context this one continues; `null` after a clear, or for the first turn. */
  readonly follows: string | null;
  readonly trace?: TraceContext;
}

/** One thing a paused turn waits on. */
export type TurnAwaiting =
  | { readonly interactionId: string }
  | { readonly callId: string }
  | { readonly taskId: string };

export interface TurnPausedData {
  readonly turnId: string;
  readonly awaiting: readonly TurnAwaiting[];
}

export interface TurnResumedData {
  readonly turnId: string;
  readonly cause: Cause;
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
export type TurnPaused = Envelope<"turn.paused", TurnPausedData>;
export type TurnResumed = Envelope<"turn.resumed", TurnResumedData>;
export type TurnSettled = Envelope<"turn.settled", TurnSettledData>;
export type TurnFact = TurnStarted | TurnPaused | TurnResumed | TurnSettled;

const awaiting = conforming<TurnAwaiting>()(
  z.union([z.object({ interactionId: id }), z.object({ callId: id }), z.object({ taskId: id })]),
);

export const turnSchemas = {
  "turn.paused": envelopeOf(
    "turn.paused",
    conforming<TurnPausedData>()(z.object({ awaiting: z.array(awaiting), turnId: id })),
  ),
  "turn.resumed": envelopeOf(
    "turn.resumed",
    conforming<TurnResumedData>()(z.object({ cause, turnId: id })),
  ),
  "turn.settled": envelopeOf(
    "turn.settled",
    conforming<TurnSettledData>()(
      z.object({
        cause: cause.optional(),
        error: errorInfo.optional(),
        outcome: z.enum(TURN_OUTCOMES),
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
