import type { DB } from "./db.ts";
// Product policy: deliberately not configurable by callers or environment variables.
export const CONTENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const contentCutoff = (time = Date.now()) => time - CONTENT_RETENTION_MS;
export async function pruneContent(db: DB, time = Date.now()) {
  const cutoff = contentCutoff(time);
  for (const table of ["message_streams", "alerts", "native_deliveries", "messages", "jobs"])
    await db.query(`DELETE FROM ${table} WHERE created<=$1`, [cutoff]);
  await db.query("DELETE FROM pairs WHERE expires<=$1", [time]);
}
