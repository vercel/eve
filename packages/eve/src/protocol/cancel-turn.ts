import { z } from "#compiled/zod/index.js";

/** Outcome of requesting cooperative turn cancellation. */
export type CancelTurnStatus = "accepted" | "no_active_turn";

/** Successful standard turn-cancellation response. */
export interface CancelTurnResponse {
  readonly ok: true;
  readonly sessionId: string;
  readonly status: CancelTurnStatus;
}

/** Successful response returned by the standard turn-cancellation route. */
export const CancelTurnResponseSchema: z.ZodType<CancelTurnResponse> = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  status: z.enum(["accepted", "no_active_turn"]),
});
