import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StoredWait {
  readonly waitId: string;
  readonly runId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly resumeAt?: string;
  readonly completedAt?: string;
}

export function readLocalWorldWaits(dataDir: string, tag: string | null = null): StoredWait[] {
  return readLocalWorldDatabase(
    dataDir,
    (db) =>
      db
        .prepare("SELECT waits.doc FROM waits JOIN runs USING (run_id) WHERE runs.tag IS ?")
        .all(tag)
        .map(({ doc }) => JSON.parse(String(doc), decodeStoredDate) as StoredWait),
    [],
  );
}

export function countLocalWorldActiveSteps(dataDir: string): number {
  return readLocalWorldDatabase(
    dataDir,
    (db) =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM steps WHERE doc ->> '$.status' IN ('pending', 'running')",
          )
          .get()?.count,
      ),
    0,
  );
}

export function rewriteLocalWorldRunAttributes(
  dataDir: string,
  runId: string,
  patch: Record<string, string | undefined>,
): void {
  if (!existsSync(join(dataDir, "world.db"))) {
    throw new Error(`The World stored no run "${runId}".`);
  }
  const db = openDatabase(dataDir, false);
  try {
    const row = db.prepare("SELECT doc FROM runs WHERE run_id = ?").get(runId);
    if (row === undefined) throw new Error(`The World stored no run "${runId}".`);
    const run = JSON.parse(String(row.doc)) as { attributes?: Record<string, string> };
    const attributes = { ...run.attributes };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete attributes[key];
      else attributes[key] = value;
    }
    db.prepare("UPDATE runs SET doc = ? WHERE run_id = ?").run(
      JSON.stringify({ ...run, attributes }),
      runId,
    );
  } finally {
    db.close();
  }
}

function readLocalWorldDatabase<T>(dataDir: string, read: (db: DatabaseSync) => T, empty: T): T {
  if (!existsSync(join(dataDir, "world.db"))) return empty;
  const db = openDatabase(dataDir, true);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function openDatabase(dataDir: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "world.db"), { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function decodeStoredDate(_key: string, value: unknown): unknown {
  const tagged = value as { __type?: unknown; value?: unknown } | null;
  return tagged?.__type === "Date" ? tagged.value : value;
}
