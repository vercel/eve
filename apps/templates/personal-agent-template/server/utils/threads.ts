import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { ThreadRecord, ThreadState, ThreadSummary } from "#shared/types/thread";
import { truncateThreadTitle } from "#shared/types/thread";

const LIST_LIMIT = 50;

function parseThreadState(value: string | null): ThreadState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ThreadState;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function serializeThreadState(state: ThreadState | undefined) {
  return state ? JSON.stringify(state) : null;
}

function mergeThreadState(incoming: ThreadState): ThreadState {
  const session = incoming.session;

  return {
    session: {
      sessionId: session.sessionId,
      streamIndex: session.streamIndex,
    },
    events: incoming.events,
  };
}

function rowToSummary(row: typeof schema.threads.$inferSelect): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function rowToRecord(row: typeof schema.threads.$inferSelect): ThreadRecord {
  return {
    ...rowToSummary(row),
    state: parseThreadState(row.state),
  };
}

export async function listThreadsForUser(userId: string): Promise<ThreadSummary[]> {
  const rows = await db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.userId, userId))
    .orderBy(desc(schema.threads.updatedAt))
    .limit(LIST_LIMIT);

  return rows.map(rowToSummary);
}

export async function getThreadForUser(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.id, id), eq(schema.threads.userId, userId)))
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function createThreadForUser(userId: string, input: { id?: string; title?: string }) {
  const id = input.id ?? crypto.randomUUID();
  const title = input.title?.trim() || "New chat";

  await db.insert(schema.threads).values({
    id,
    userId,
    title: truncateThreadTitle(title),
  });

  const created = await getThreadForUser(userId, id);
  if (!created) {
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to create thread",
    });
  }

  return created;
}

export async function updateThreadForUser(
  userId: string,
  id: string,
  patch: {
    title?: string;
    state?: ThreadState;
  },
) {
  const existing = await getThreadForUser(userId, id);
  if (!existing) {
    return undefined;
  }

  await db
    .update(schema.threads)
    .set({
      updatedAt: new Date(),
      ...(patch.title !== undefined ? { title: truncateThreadTitle(patch.title) } : {}),
      ...(patch.state !== undefined
        ? { state: serializeThreadState(mergeThreadState(patch.state)) }
        : {}),
    })
    .where(and(eq(schema.threads.id, id), eq(schema.threads.userId, userId)));

  return getThreadForUser(userId, id);
}

export async function deleteThreadForUser(userId: string, id: string) {
  const existing = await getThreadForUser(userId, id);
  if (!existing) {
    return false;
  }

  await db
    .delete(schema.threads)
    .where(and(eq(schema.threads.id, id), eq(schema.threads.userId, userId)));

  return true;
}
