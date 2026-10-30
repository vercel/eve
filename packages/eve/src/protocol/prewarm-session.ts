import { z } from "#compiled/zod/index.js";
/** Acceptance is durable, but does not mean the successor has activated. */
export type PrewarmSessionResult = {
  readonly status: "ready" | "accepted" | "unsupported" | "no_active_session";
};
export const PrewarmResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(["ready", "accepted", "unsupported", "no_active_session"]),
});
