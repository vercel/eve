import { createHash } from "node:crypto";

/** Derives the private Vercel Queues topic used by one eve agent's schedule collections. */
export function deriveEveScheduleQueueTopic(application: string): string {
  const normalized = application.trim();
  if (normalized.length === 0) throw new Error("Schedule application must not be empty.");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `__eve_schedule_${digest}`;
}
