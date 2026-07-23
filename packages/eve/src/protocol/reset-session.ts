import { z } from "#compiled/zod/index.js";

/** Outcome of retiring the owner of a continuation token. */
export type ResetStatus = "no_active_session" | "reset";

/** Successful response returned by the standard session-reset route. */
export type ResetResponse =
  | {
      readonly ok: true;
      readonly previousSessionId: string;
      readonly status: "reset";
    }
  | {
      readonly ok: true;
      readonly status: "no_active_session";
    };

/** Validates successful responses from the standard session-reset route. */
export const ResetResponseSchema: z.ZodType<ResetResponse> = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    previousSessionId: z.string().min(1),
    status: z.literal("reset"),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("no_active_session"),
  }),
]);
