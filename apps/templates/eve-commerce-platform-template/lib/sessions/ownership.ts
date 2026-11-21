import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import type { AccessScope } from "@/lib/auth/scope";
import { ensureShopper } from "@/lib/shoppers/store";

export async function claimSession(scope: AccessScope, sessionId: string, deliveredAt?: Date) {
  await ensureShopper(scope);
  const insert = db.insert(agentSessions).values({
    sessionId,
    shopperId: scope.userId,
    lastDeliveryAt: deliveredAt,
  });
  if (!deliveredAt) {
    await insert.onConflictDoNothing({ target: agentSessions.sessionId });
    return;
  }

  await insert.onConflictDoUpdate({
    target: agentSessions.sessionId,
    // A delayed delivery must not move a session backward in the list.
    set: {
      lastDeliveryAt: sql`greatest(${agentSessions.lastDeliveryAt}, excluded.last_delivery_at)`,
    },
    setWhere: eq(agentSessions.shopperId, scope.userId),
  });
}

export async function isSessionOwned(scope: AccessScope, sessionId: string) {
  const [session] = await db
    .select({ sessionId: agentSessions.sessionId })
    .from(agentSessions)
    .where(and(eq(agentSessions.shopperId, scope.userId), eq(agentSessions.sessionId, sessionId)))
    .limit(1);
  return session !== undefined;
}
