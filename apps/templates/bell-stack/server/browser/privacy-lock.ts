import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { isLinkSandbox } from "../link/sandbox";

const current = new AsyncLocalStorage<() => Promise<void>>();
const sandboxBrowsers = new Map<string, { tail: Promise<void>; quarantined: boolean }>();
let pool: Pool | undefined;

export async function quarantineBrowser(): Promise<void> {
  const lock = current.getStore();
  if (!lock) throw new Error("Payment requires a private browser lock.");
  await lock();
}

export async function withBrowserPrivacyLock<T>(sessionId: string, operation: () => Promise<T>, database?: Pool, existingBrowser = false): Promise<T> {
  if (!database && isLinkSandbox()) {
    if (!process.env.LINK_SANDBOX_ACCESS_TOKEN?.trim()) return operation();
    let state = sandboxBrowsers.get(sessionId);
    if (!state && existingBrowser) throw new Error("The sandbox cannot recover a browser from another process. Use human handoff to inspect the existing purchase; do not retry it.");
    if (!state) { state = { tail: Promise.resolve(), quarantined: false }; sandboxBrowsers.set(sessionId, state); }
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (state.quarantined) throw new Error("Payment details may remain in this browser. Use human handoff; do not retry payment.");
      return await current.run(async () => { state.quarantined = true; }, operation);
    } finally { release(); }
  }
  if (!database && !process.env.LINK_CLIENT_ID?.trim()) return operation();
  if (!database && !process.env.DATABASE_URL) throw new Error("Link checkout requires DATABASE_URL.");
  if (!database && !pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, allowExitOnIdle: true });
    pool.on("error", () => console.error("Browser privacy database connection failed."));
  }
  const client = await (database ?? pool!).connect();
  let locked = false, destroy = false;
  const key = `bell-browser-privacy:${sessionId}`;
  try {
    await client.query("SET statement_timeout='30s'");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
    locked = true;
    if ((await client.query("SELECT 1 FROM bell_browser_privacy_guards WHERE session_id=$1", [sessionId])).rowCount)
      throw new Error("Payment details may remain in this browser. Use human handoff to inspect the existing purchase; do not retry it. Start a new conversation for further browser automation.");
    return await current.run(async () => {
      await client.query("INSERT INTO bell_browser_privacy_guards(session_id) VALUES($1) ON CONFLICT DO NOTHING", [sessionId]);
    }, operation);
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
      catch { destroy = true; }
    } else destroy = true;
    client.release(destroy);
  }
}
