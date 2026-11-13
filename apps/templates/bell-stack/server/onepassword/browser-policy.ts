import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
const activeLock = new AsyncLocalStorage<{ client: PoolClient; sessionId: string }>();
export async function markSecretFill(blocked: boolean): Promise<void> {
  const lock = activeLock.getStore();
  if (!lock) throw new Error("A private browser lock is required.");
  if (blocked) await lock.client.query("INSERT INTO bell_onepassword_browser_guards(session_id) VALUES($1) ON CONFLICT DO NOTHING", [lock.sessionId]);
  else await lock.client.query("DELETE FROM bell_onepassword_browser_guards WHERE session_id=$1", [lock.sessionId]);
}
export function personalBrowserEnabled(): boolean { return Boolean(process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID?.trim()); }
export function requireReusableContexts(): void {
  if (personalBrowserEnabled()) throw new Error("Reusable browser Contexts are disabled for personal 1Password. Start a new private conversation instead.");
}
let pool: Pool | undefined;
export async function withPersonalBrowserLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  if (!personalBrowserEnabled()) return operation();
  if (!process.env.DATABASE_URL) throw new Error("Personal 1Password requires DATABASE_URL.");
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, allowExitOnIdle: true });
    pool.on("error", () => console.error("Private browser database connection failed."));
  }
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("SET statement_timeout='30s'");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`bell-private-browser:${sessionId}`]);
    if ((await client.query("SELECT 1 FROM bell_onepassword_browser_guards WHERE session_id=$1", [sessionId])).rowCount) throw new Error("A private login did not finish safely. Start a new conversation.");
    return await activeLock.run({ client, sessionId }, operation);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`bell-private-browser:${sessionId}`]); }
    catch { destroy = true; }
    client.release(destroy);
  }
}
