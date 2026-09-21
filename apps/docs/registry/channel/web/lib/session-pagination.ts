import { sortSessions, type ChatSession } from "./session-history.ts";

export interface SessionPage {
  readonly sessions: readonly ChatSession[];
  readonly nextCursor?: string;
}

export interface SessionPageQuery {
  readonly limit: number;
  readonly after?: { readonly at: string; readonly id: string };
}

export function parseSessionPageQuery(url: URL): SessionPageQuery {
  const limit = Number(url.searchParams.get("limit") ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be between 1 and 100.");
  }
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return { limit };
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value.version !== 1 ||
      typeof value.at !== "string" ||
      !Number.isFinite(Date.parse(value.at)) ||
      typeof value.id !== "string" ||
      !/^wrun_[A-Za-z0-9]+$/.test(value.id)
    )
      throw new Error();
    return { limit, after: { at: new Date(value.at).toISOString(), id: value.id } };
  } catch {
    throw new Error("Invalid session cursor.");
  }
}

export function sessionCursor(session: ChatSession): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      at: session.lastMessageAt ?? session.createdAt,
      id: session.id,
    }),
  ).toString("base64url");
}

export function paginateSessions(
  sessions: readonly ChatSession[],
  query: SessionPageQuery,
): SessionPage {
  const after = query.after;
  const ordered = sortSessions(sessions).filter((session) => {
    if (!after) return true;
    const at = Date.parse(session.lastMessageAt ?? session.createdAt);
    return at < Date.parse(after.at) || (at === Date.parse(after.at) && session.id > after.id);
  });
  const page = ordered.slice(0, query.limit);
  return {
    sessions: page,
    ...(ordered.length > query.limit ? { nextCursor: sessionCursor(page.at(-1)!) } : {}),
  };
}
