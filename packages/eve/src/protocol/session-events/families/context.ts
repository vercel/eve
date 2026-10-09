import { z } from "#compiled/zod/index.js";

import { CONTEXT_OUTCOMES } from "../catalog.js";
import { cause, conforming, envelopeOf, errorInfo, id } from "../common.js";
import type { Cause, Envelope, ErrorInfo } from "../envelope.js";

/** A context change's kind. Open: `compaction` and `clear` today. */
export type ContextKind = "compaction" | "clear" | (string & {});

export interface ContextStartedData {
  readonly changeId: string;
  readonly kind: ContextKind;
  /** The turn a threshold compaction ran in. */
  readonly turnId?: string;
  /** The control delivery for a manual change. */
  readonly cause?: Cause;
  /** What started a threshold compaction. */
  readonly trigger?: { readonly inputTokens: number };
}

export type ContextOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export interface ContextSettledData {
  readonly changeId: string;
  readonly kind: ContextKind;
  readonly outcome: ContextOutcome;
  /**
   * The change's effect on the conversation: `null` empties it until the next turn, a turn
   * selects that turn. Absent when the conversation is unchanged, as for a compaction.
   */
  readonly selects?: null | { readonly turnId: string };
  readonly error?: ErrorInfo;
}

export type ContextStarted = Envelope<"context.started", ContextStartedData>;
export type ContextSettled = Envelope<"context.settled", ContextSettledData>;
export type ContextFact = ContextStarted | ContextSettled;

export const contextSchemas = {
  "context.settled": envelopeOf(
    "context.settled",
    conforming<ContextSettledData>()(
      z.object({
        changeId: id,
        error: errorInfo.optional(),
        kind: z.string(),
        outcome: z.enum(CONTEXT_OUTCOMES),
        selects: z.object({ turnId: id }).nullable().optional(),
      }),
    ),
  ),
  "context.started": envelopeOf(
    "context.started",
    conforming<ContextStartedData>()(
      z.object({
        cause: cause.optional(),
        changeId: id,
        kind: z.string(),
        trigger: z.object({ inputTokens: z.number().int().nonnegative() }).optional(),
        turnId: id.optional(),
      }),
    ),
  ),
};
