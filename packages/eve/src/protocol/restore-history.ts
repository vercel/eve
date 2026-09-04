import { z } from "#compiled/zod/index.js";

/** Request body for restoring an exact model-history snapshot prefix. */
export const RestoreHistoryRequestSchema = z.object({
  to: z.number().int().nonnegative(),
});

export type RestoreHistoryRequest = z.infer<typeof RestoreHistoryRequestSchema>;

/** Outcome of queueing model-history restoration. */
export type RestoreHistoryStatus = "accepted" | "no_active_session";

/** Successful response returned by the session history-restoration route. */
export type RestoreHistoryResponse =
  | { readonly ok: true; readonly sessionId: string; readonly status: "accepted" }
  | { readonly ok: true; readonly status: "no_active_session" };

/** Validates successful session history-restoration responses. */
export const RestoreHistoryResponseSchema: z.ZodType<RestoreHistoryResponse> = z.discriminatedUnion(
  "status",
  [
    z.object({
      ok: z.literal(true),
      sessionId: z.string().min(1),
      status: z.literal("accepted"),
    }),
    z.object({ ok: z.literal(true), status: z.literal("no_active_session") }),
  ],
);
