import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export interface DB {
  query<T = Record<string, unknown>>(sql: string, args?: (string | number | null)[]): Promise<T[]>;
  close(): Promise<void>;
}
export async function database(
  options: {
    url?: string;
    path?: string;
    kind?: "app" | "matchmaker";
    sandbox?: { secret: string; log?: (message: string) => void; output?: (chunk: string) => void };
  } = {},
): Promise<DB> {
  let db: DB;
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 3, prepare: false, onnotice: () => {} });
    db = {
      query: async <T>(q: string, args: (string | number | null)[] = []) =>
        // postgres types rows as its own RowList; callers own the row shape.
        Array.from(await sql.unsafe(q, args)) as T[],
      close: () => sql.end(),
    };
  } else if (options.sandbox && options.kind === "app") {
    const { sandboxDatabase } = await import("../src/sandbox-database.ts");
    db = await sandboxDatabase(options.sandbox);
  } else {
    if (process.env.VERCEL) throw new Error("DATABASE_URL is required on Vercel");
    const { DatabaseSync } = await import("node:sqlite");
    const path = options.path || process.env.EVE_DB_PATH || ".eve/relay.sqlite";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    db = {
      query: async <T>(q: string, args: (string | number | null)[] = []) => {
        // Convert numbered placeholders in occurrence order, including repeated indexes.
        const ordered: (string | number | null)[] = [];
        const statement = q.replace(/\$(\d+)/g, (_, n) => {
          ordered.push(args[Number(n) - 1]);
          return "?";
        });
        return sqlite.prepare(statement).all(...ordered) as T[];
      },
      close: async () => sqlite.close(),
    };
  }
  for (const schema of [
    "CREATE TABLE IF NOT EXISTS agent_installations (identity TEXT PRIMARY KEY, agent_id TEXT UNIQUE NOT NULL)",
    "CREATE TABLE IF NOT EXISTS push_rate_limits (agent_id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL)",
    "CREATE TABLE IF NOT EXISTS agent_tenants (agent_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS agent_tenants_tenant ON agent_tenants(tenant_id)",
    "CREATE TABLE IF NOT EXISTS browser_turns (agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, backend TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(agent_id,turn_id))",
    "CREATE TABLE IF NOT EXISTS native_deliveries (agent_id TEXT NOT NULL, event_id TEXT NOT NULL, session_id TEXT, start_index INTEGER, created BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,event_id))",
    "CREATE TABLE IF NOT EXISTS web_sessions (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, password_version TEXT NOT NULL, expires BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS web_login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_hash TEXT NOT NULL, desktop_hash TEXT NOT NULL, desktop_seen BIGINT NOT NULL DEFAULT 0, browser_ready INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS desktop_pairings (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS pairs (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires BIGINT NOT NULL, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, push_token TEXT)",
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created BIGINT NOT NULL, event_done INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS message_streams (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, event_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created BIGINT NOT NULL, updated BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS streams_agent ON message_streams(agent_id)",
    "CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, created)",
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, lease TEXT, lease_until BIGINT NOT NULL DEFAULT 0, expires BIGINT NOT NULL, created BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS jobs_agent ON jobs(agent_id, state, created)",
    "CREATE TABLE IF NOT EXISTS desktop_keys (agent_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL)",
    "CREATE TABLE IF NOT EXISTS remote_desktops (agent_id TEXT PRIMARY KEY, sandbox_name TEXT NOT NULL, drive_name TEXT NOT NULL, state TEXT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, error TEXT)",
    "CREATE TABLE IF NOT EXISTS agent_state (agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(agent_id,key))",
    "CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, dedupe TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt BIGINT NOT NULL, created BIGINT NOT NULL DEFAULT 0, UNIQUE(agent_id, dedupe))",
  ]) {
    const table =
      schema.match(/TABLE IF NOT EXISTS ([a-z_]+)/)?.[1] || schema.match(/ ON ([a-z_]+)/)?.[1];
    const computer = [
      "web_sessions",
      "web_login_limits",
      "agents",
      "desktop_pairings",
      "jobs",
      "desktop_keys",
      "remote_desktops",
      "agent_state",
      "browser_turns",
    ];
    const app = [
      ...computer,
      "pairs",
      "devices",
      "messages",
      "message_streams",
      "native_deliveries",
      "alerts",
    ];
    const matchmaking = [
      "agent_installations",
      "tenants",
      "agent_tenants",
      "agents",
      "pairs",
      "push_rate_limits",
    ];
    const allowed = options.kind === "matchmaker" ? matchmaking : app;
    if (table && !allowed.includes(table)) continue;
    await db.query(schema);
  }
  if (options.kind === "matchmaker") {
    const columns = url
      ? await db.query<{ name: string }>(
          "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pairs'",
        )
      : await db.query<{ name: string }>("PRAGMA table_info(pairs)");
    if (!columns.some((column) => column.name === "payload"))
      try {
        await db.query("ALTER TABLE pairs ADD COLUMN payload TEXT");
      } catch (error) {
        if (
          (error as { code?: string }).code !== "42701" &&
          !/duplicate column name/i.test((error as Error).message)
        )
          throw error;
      }
  }
  if (options.kind !== "matchmaker") {
    for (const table of ["messages", "message_streams"]) {
      const columns = url
        ? await db.query<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
            [table],
          )
        : await db.query<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((column) => column.name === "tools"))
        try {
          await db.query(`ALTER TABLE ${table} ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`);
        } catch (error) {
          if (
            (error as { code?: string }).code !== "42701" &&
            !/duplicate column name/i.test((error as Error).message)
          )
            throw error;
        }
    }
    // Receipts survive HTTP retries; eve owns delivery ordering and execution.
    const receiptColumns = url
      ? await db.query<{ name: string }>(
          "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='native_deliveries'",
        )
      : await db.query<{ name: string }>("PRAGMA table_info(native_deliveries)");
    for (const name of ["delivery_key", "turn_id"])
      if (!receiptColumns.some((c) => c.name === name)) {
        try {
          await db.query(`ALTER TABLE native_deliveries ADD COLUMN ${name} TEXT`);
        } catch (error) {
          if (
            (error as { code?: string }).code !== "42701" &&
            !/duplicate column name/i.test((error as Error).message)
          )
            throw error;
        }
      }
    // Existing installations predate creation timestamps on the outbox and receipts.
    for (const table of ["alerts", "native_deliveries"]) {
      const columns = url
        ? await db.query<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
            [table],
          )
        : await db.query<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((column) => column.name === "created"))
        try {
          await db.query(`ALTER TABLE ${table} ADD COLUMN created BIGINT NOT NULL DEFAULT 0`);
        } catch (error) {
          if (
            (error as { code?: string }).code !== "42701" &&
            !/duplicate column name/i.test((error as Error).message)
          )
            throw error;
        }
    }
    await db.query(
      "UPDATE alerts SET created=COALESCE((SELECT m.created FROM messages m WHERE m.id=alerts.message_id AND m.agent_id=alerts.agent_id),0) WHERE created=0",
    );
    await db.query(
      "UPDATE native_deliveries SET created=COALESCE((SELECT m.created FROM messages m WHERE m.id=native_deliveries.event_id AND m.agent_id=native_deliveries.agent_id),0) WHERE created=0",
    );
    for (const table of ["messages", "message_streams", "alerts", "native_deliveries"])
      await db.query(`CREATE INDEX IF NOT EXISTS ${table}_retention ON ${table}(created)`);
  }
  return db;
}
