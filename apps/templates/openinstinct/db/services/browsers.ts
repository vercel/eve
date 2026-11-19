import { and, desc, eq, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserSessions, db } from "@db";

interface BrowserSessionRecord {
  readonly createdAt: string;
  readonly sessionId: string;
  readonly workerSessionId: string | null;
}

export async function createBrowserSession(
  scope: AccessScope,
  record: BrowserSessionRecord
) {
  await db.insert(browserSessions).values({
    createdAt: new Date(record.createdAt),
    createdByUserId: scope.userId,
    sessionId: record.sessionId,
    workerSessionId: record.workerSessionId,
    workspaceId: scope.workspaceId,
  });
}

export async function listWorkerBrowserSessions(
  scope: AccessScope,
  workerSessionId: string
) {
  const rows = await db
    .select({
      createdAt: browserSessions.createdAt,
      sessionId: browserSessions.sessionId,
    })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.workspaceId, scope.workspaceId),
        eq(browserSessions.workerSessionId, workerSessionId)
      )
    )
    .orderBy(desc(browserSessions.createdAt));
  return rows.map(serializeBrowserSession);
}

export async function listBrowserSessions(scope: AccessScope) {
  const rows = await db
    .select({
      createdAt: browserSessions.createdAt,
      sessionId: browserSessions.sessionId,
    })
    .from(browserSessions)
    .where(eq(browserSessions.workspaceId, scope.workspaceId))
    .orderBy(desc(browserSessions.createdAt));
  return rows.map(serializeBrowserSession);
}

export async function readBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  const rows = await db
    .select({
      createdAt: browserSessions.createdAt,
      sessionId: browserSessions.sessionId,
      workerSessionId: browserSessions.workerSessionId,
    })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.workspaceId, scope.workspaceId),
        eq(browserSessions.sessionId, sessionId)
      )
    )
    .limit(1);
  return rows[0] ? serializeBrowserSession(rows[0]) : undefined;
}

function serializeBrowserSession<T extends { createdAt: Date }>(record: T) {
  const { createdAt, ...session } = record;
  return { ...session, createdAt: createdAt.toISOString() };
}

export async function deleteBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  const rows = await db
    .delete(browserSessions)
    .where(
      and(
        eq(browserSessions.workspaceId, scope.workspaceId),
        eq(browserSessions.sessionId, sessionId)
      )
    )
    .returning({ sessionId: browserSessions.sessionId });
  return rows.length > 0;
}

export async function withBrowserProfileWriteLock<T>(
  scope: AccessScope,
  operation: () => Promise<T>
) {
  return db.transaction(async (transaction) => {
    const result = await transaction.execute<{ acquired: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${scope.workspaceId}, 0)) AS "acquired"`
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error(
        "Another browser profile update is starting for this workspace. Retry after it finishes."
      );
    }
    return operation();
  });
}
