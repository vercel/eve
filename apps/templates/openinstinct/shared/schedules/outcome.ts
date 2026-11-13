import { z } from "zod";

const artifactSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(200).optional(),
});

export const scheduledRunOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("nothing_to_report"),
    reason: z.string().trim().min(1).max(2_000),
  }),
  z.strictObject({
    artifacts: z.array(artifactSchema).max(4).optional(),
    details: z.string().trim().min(1).max(8_000).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    kind: z.literal("result"),
    summary: z.string().trim().min(1).max(4_000),
    urgency: z.enum(["normal", "time_sensitive"]),
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    summary: z.string().trim().min(1).max(4_000),
    userActionNeeded: z.string().trim().min(1).max(2_000),
  }),
]);

export type ScheduledRunOutcome = z.infer<typeof scheduledRunOutcomeSchema>;
