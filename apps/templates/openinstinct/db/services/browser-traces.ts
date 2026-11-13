import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  browserTraceDomains,
  browserTraceEvents,
  browserTraces,
  db,
} from "@db";

type CompletedBrowserTraceStatus = Exclude<
  typeof browserTraces.$inferSelect.status,
  "running"
>;

const traceHistoryPageSize = 25;

const traceCursorSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.string().min(1),
});

function decodeTraceCursor(cursor: string) {
  try {
    return traceCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    );
  } catch {
    throw new Error("Invalid browser trace cursor.");
  }
}

function encodeTraceCursor(boundary: z.infer<typeof traceCursorSchema>) {
  return Buffer.from(JSON.stringify(boundary)).toString("base64url");
}

export async function listBrowserTraces(scope: AccessScope, cursor?: string) {
  const boundary = cursor === undefined ? undefined : decodeTraceCursor(cursor);
  const rows = await db.query.browserTraces.findMany({
    columns: { createdByUserId: false, workspaceId: false },
    limit: traceHistoryPageSize + 1,
    orderBy: [desc(browserTraces.startedAt), desc(browserTraces.sessionId)],
    where: and(
      eq(browserTraces.workspaceId, scope.workspaceId),
      boundary
        ? sql`(${browserTraces.startedAt}, ${browserTraces.sessionId}) < (${new Date(boundary.startedAt)}, ${boundary.sessionId})`
        : undefined
    ),
    with: {
      domains: {
        columns: { domain: true },
        orderBy: [asc(browserTraceDomains.domain)],
      },
    },
  });

  const page = rows.slice(0, traceHistoryPageSize);
  const last = page.at(-1);

  return {
    nextCursor:
      rows.length > page.length && last
        ? encodeTraceCursor({
            sessionId: last.sessionId,
            startedAt: last.startedAt.toISOString(),
          })
        : null,
    traces: page.map(serializeBrowserTrace),
  };
}

export type BrowserTracePage = Awaited<ReturnType<typeof listBrowserTraces>>;

export async function readBrowserTrace(scope: AccessScope, sessionId: string) {
  const trace = await db.query.browserTraces.findFirst({
    columns: { createdByUserId: false, workspaceId: false },
    where: and(
      eq(browserTraces.workspaceId, scope.workspaceId),
      eq(browserTraces.sessionId, sessionId)
    ),
    with: {
      domains: {
        columns: { domain: true },
        orderBy: [asc(browserTraceDomains.domain)],
      },
    },
  });
  if (!trace) return undefined;
  return serializeBrowserTrace(trace);
}

export async function beginBrowserTrace(
  scope: AccessScope,
  record: { sessionId: string; task: string; startedAt: string }
) {
  await db
    .insert(browserTraces)
    .values({
      createdByUserId: scope.userId,
      sessionId: record.sessionId,
      startedAt: new Date(record.startedAt),
      status: "running",
      task: record.task,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      set: { completedAt: null, durationMs: null, status: "running" },
      target: browserTraces.sessionId,
    });
}

export async function completeBrowserTrace(
  scope: AccessScope,
  sessionId: string,
  outcome: {
    completedAt: string;
    resultMessage?: string;
    status: CompletedBrowserTraceStatus;
  }
) {
  await db
    .update(browserTraces)
    .set({
      completedAt: new Date(outcome.completedAt),
      durationMs: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${new Date(outcome.completedAt)} - ${browserTraces.startedAt})) * 1000))::int`,
      resultMessage: outcome.resultMessage,
      status: outcome.status,
    })
    .where(
      and(
        eq(browserTraces.workspaceId, scope.workspaceId),
        eq(browserTraces.sessionId, sessionId)
      )
    );
}

export async function recordBrowserTraceEvents(
  scope: AccessScope,
  traceSessionId: string,
  events: readonly {
    at: string;
    detail: string;
    id: string;
    label: string;
    type: string;
  }[]
) {
  if (events.length === 0) return;
  const owned = await db
    .select({ sessionId: browserTraces.sessionId })
    .from(browserTraces)
    .where(
      and(
        eq(browserTraces.workspaceId, scope.workspaceId),
        eq(browserTraces.sessionId, traceSessionId)
      )
    )
    .limit(1);
  if (owned.length === 0) return;

  await db
    .insert(browserTraceEvents)
    .values(
      events.map((event) => ({
        ...event,
        at: new Date(event.at),
        traceSessionId,
      }))
    )
    .onConflictDoNothing({ target: browserTraceEvents.id });
}

const traceEventReadLimit = 2000;

export async function listBrowserTraceEvents(
  scope: AccessScope,
  traceSessionId: string
) {
  const events = await db
    .select({
      at: browserTraceEvents.at,
      detail: browserTraceEvents.detail,
      id: browserTraceEvents.id,
      label: browserTraceEvents.label,
      type: browserTraceEvents.type,
    })
    .from(browserTraceEvents)
    .innerJoin(
      browserTraces,
      eq(browserTraces.sessionId, browserTraceEvents.traceSessionId)
    )
    .where(
      and(
        eq(browserTraces.workspaceId, scope.workspaceId),
        eq(browserTraceEvents.traceSessionId, traceSessionId)
      )
    )
    .orderBy(asc(browserTraceEvents.id))
    .limit(traceEventReadLimit);
  return events.map((event) =>
    Object.assign({}, event, { at: event.at.toISOString() })
  );
}

export async function recordBrowserTraceDomains(
  scope: AccessScope,
  traceSessionId: string,
  domains: readonly string[]
) {
  if (domains.length === 0) return;
  const owned = await db
    .select({ sessionId: browserTraces.sessionId })
    .from(browserTraces)
    .where(
      and(
        eq(browserTraces.workspaceId, scope.workspaceId),
        eq(browserTraces.sessionId, traceSessionId)
      )
    )
    .limit(1);
  if (owned.length === 0) return;

  const firstSeenAt = new Date();
  await db
    .insert(browserTraceDomains)
    .values(
      [...new Set(domains)].map((domain) => ({
        domain,
        firstSeenAt,
        traceSessionId,
      }))
    )
    .onConflictDoNothing({
      target: [browserTraceDomains.traceSessionId, browserTraceDomains.domain],
    });
}

function serializeBrowserTrace<
  T extends {
    completedAt: Date | null;
    domains: { domain: string }[];
    startedAt: Date;
  },
>({ domains, ...trace }: T) {
  return {
    ...trace,
    completedAt: trace.completedAt?.toISOString() ?? null,
    domains: domains.map(({ domain }) => domain),
    startedAt: trace.startedAt.toISOString(),
  };
}
