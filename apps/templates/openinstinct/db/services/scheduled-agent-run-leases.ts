import { and, eq, gt } from "drizzle-orm";
import { db, scheduledAgentRuns } from "@db";

export async function isScheduledAgentRunLeaseActive(
  runId: string,
  leaseToken: string,
  now = new Date()
) {
  const run = await db.query.scheduledAgentRuns.findFirst({
    columns: { id: true },
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.status, "running"),
      eq(scheduledAgentRuns.leaseToken, leaseToken),
      gt(scheduledAgentRuns.leaseExpiresAt, now)
    ),
  });
  return run !== undefined;
}
