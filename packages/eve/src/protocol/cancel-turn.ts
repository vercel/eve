import { z } from "#compiled/zod/index.js";

export type CancelTurnResult =
  | { readonly sessionId: string; readonly status: "accepted" }
  | { readonly status: "no_active_turn" };

export type CancelTurnResponse = CancelTurnResult & { readonly ok: true };

export const CancelTurnResponseSchema: z.ZodType<CancelTurnResponse> = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      ok: z.literal(true),
      sessionId: z.string().min(1),
      status: z.literal("accepted"),
    }),
    z.strictObject({ ok: z.literal(true), status: z.literal("no_active_turn") }),
  ],
);
