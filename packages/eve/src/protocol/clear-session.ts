import { z } from "#compiled/zod/index.js";

export type ClearStatus = "accepted" | "no_active_session";

export type ClearResponse =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly status: "accepted";
    }
  | {
      readonly ok: true;
      readonly status: "no_active_session";
    };

export const ClearResponseSchema: z.ZodType<ClearResponse> = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("no_active_session"),
  }),
]);
