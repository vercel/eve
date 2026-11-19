import { z } from "#compiled/zod/index.js";

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
