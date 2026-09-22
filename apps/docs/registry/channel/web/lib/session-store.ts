import { createHash } from "node:crypto";
import type { ChatSession } from "./session-history.ts";
import { sessionCursor, type SessionPage, type SessionPageQuery } from "./session-pagination.ts";

export type SessionQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
export interface SessionOwner {
  readonly key: string;
  readonly name: string;
}
/** Map an authenticated browser user to index ownership without changing its auth principal. */
export function sessionOwner(
  user:
    | {
        vercelSubject?: string | null;
        name: string;
        email: string;
      }
    | null
    | undefined,
): SessionOwner | null {
  if (!user) return null;
  if (!user.vercelSubject) throw new Error("Sign in again to access session history.");
  return {
    key: createHash("sha256")
      .update(JSON.stringify(["better-auth:vercel", user.vercelSubject]))
      .digest("hex"),
    name: user.name || user.email,
  };
}

export interface SessionRecord extends ChatSession {
  readonly ownerKey: string;
  readonly titleAt?: string;
}

/** This index owns browser access and metadata. eve remains the transcript store. */
export function createSessionStore(query: SessionQuery, scope: string) {
  return {
    async recordChild(root: string, parent: string, call: string, child: string) {
      await query(
        `INSERT INTO web_session_children (scope, owner_key, parent_session_id, call_id, child_session_id)
        SELECT scope, owner_key, $3, $4, $5 FROM web_sessions
        WHERE scope = $1 AND session_id = $2 ON CONFLICT DO NOTHING`,
        [scope, root, parent, call, child],
      );
    },
    async ownsChild(ownerKey: string, parent: string, call: string, child: string) {
      const rows = await query(
        `SELECT 1 FROM web_session_children WHERE scope = $1 AND owner_key = $2
        AND parent_session_id = $3 AND call_id = $4 AND child_session_id = $5`,
        [scope, ownerKey, parent, call, child],
      );
      return rows.length === 1;
    },
    async owns(ownerKey: string, id: string) {
      const rows = await query(
        "SELECT 1 FROM web_sessions WHERE scope = $1 AND session_id = $2 AND owner_key = $3",
        [scope, id, ownerKey],
      );
      return rows.length === 1;
    },
    async record(session: SessionRecord) {
      const rows = await query(
        `INSERT INTO web_sessions AS s
        (scope, session_id, owner_key, title, title_at, created_at, last_message_at, last_turn_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (scope, session_id) DO UPDATE SET
          created_at = LEAST(s.created_at, EXCLUDED.created_at),
          title = CASE WHEN EXCLUDED.title_at IS NOT NULL AND (s.title_at IS NULL OR EXCLUDED.title_at < s.title_at) THEN EXCLUDED.title ELSE s.title END,
          title_at = LEAST(s.title_at, EXCLUDED.title_at),
          last_message_at = GREATEST(s.last_message_at, EXCLUDED.last_message_at),
          last_turn_at = GREATEST(s.last_turn_at, EXCLUDED.last_turn_at)
        WHERE s.owner_key = EXCLUDED.owner_key
        RETURNING session_id`,
        [
          scope,
          session.id,
          session.ownerKey,
          session.title,
          session.titleAt ?? null,
          session.createdAt,
          session.lastMessageAt ?? null,
          session.lastTurnAt ?? null,
        ],
      );
      if (rows.length !== 1) throw new Error("Session ownership conflict.");
    },
    async update(session: Omit<SessionRecord, "ownerKey" | "createdAt">) {
      // Hooks may arrive from any channel. Only existing browser-owned roots are projected.
      await query(
        `UPDATE web_sessions SET
          title = CASE WHEN $4::timestamptz IS NOT NULL AND (title_at IS NULL OR $4 < title_at) THEN $3 ELSE title END,
          title_at = LEAST(title_at, $4::timestamptz),
          last_message_at = GREATEST(last_message_at, $5::timestamptz),
          last_turn_at = GREATEST(last_turn_at, $6::timestamptz)
        WHERE scope = $1 AND session_id = $2`,
        [
          scope,
          session.id,
          session.title,
          session.titleAt ?? null,
          session.lastMessageAt ?? null,
          session.lastTurnAt ?? null,
        ],
      );
    },
    async list(ownerKey: string, page: SessionPageQuery): Promise<SessionPage> {
      const rows = await query(
        `SELECT session_id, title, created_at, last_message_at, last_turn_at
        FROM web_sessions WHERE scope = $1 AND owner_key = $2
        AND ($3::timestamptz IS NULL OR COALESCE(last_message_at, created_at) < $3
          OR (COALESCE(last_message_at, created_at) = $3 AND session_id > $4 COLLATE "C"))
        ORDER BY COALESCE(last_message_at, created_at) DESC, session_id ASC LIMIT $5`,
        [scope, ownerKey, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
      );
      const sessions = rows.slice(0, page.limit).map((row): ChatSession => ({
        id: String(row.session_id),
        title: String(row.title),
        createdAt: iso(row.created_at),
        ...(row.last_message_at ? { lastMessageAt: iso(row.last_message_at) } : {}),
        ...(row.last_turn_at ? { lastTurnAt: iso(row.last_turn_at) } : {}),
      }));
      return {
        sessions,
        ...(rows.length > page.limit ? { nextCursor: sessionCursor(sessions.at(-1)!) } : {}),
      };
    },
  };
}
function iso(value: unknown) {
  return new Date(value as string | Date).toISOString();
}
export type SessionStore = ReturnType<typeof createSessionStore>;
