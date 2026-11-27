import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Cron } from "#compiled/croner/index.js";
import type { ScheduleExpression, ScheduleState } from "#public/schedules/subscription.js";
import { parseScheduleLocalDateTime } from "#shared/schedule-timezone.js";

const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const STORES = Symbol.for("eve.localDevScheduleStores");

export interface LocalDevScheduleRow {
  readonly collection: string;
  readonly namespace: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly state: ScheduleState;
  readonly expression: ScheduleExpression;
  readonly payload: unknown;
  readonly nextFireAtMs: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalDevScheduleClaim {
  readonly row: LocalDevScheduleRow;
  readonly scheduledAtMs: number;
}

export interface LocalDevScheduleStore {
  get(collection: string, namespace: string, name: string): LocalDevScheduleRow | undefined;
  list(collection: string, namespace: string): readonly LocalDevScheduleRow[];
  put(row: LocalDevScheduleRow): void;
  remove(collection: string, namespace: string, name: string): boolean;
  earliestFireAtMs(): number | null;
  claimDue(nowMs: number): readonly LocalDevScheduleClaim[];
  operation<T>(operationId: string, run: () => T): T;
  onChange(listener: () => void): () => void;
  close(): void;
}

export function nextFireAtMs(expression: ScheduleExpression, afterMs: number): number | null {
  if (expression.type === "single") {
    const at = parseScheduleLocalDateTime(expression.at, expression.timezone);
    return at > afterMs ? at : null;
  }
  const next = new Cron(expression.cron, { timezone: expression.timezone ?? "UTC" }).nextRun(
    new Date(afterMs),
  );
  return next === null ? null : next.getTime();
}

export function createLocalDevScheduleStore(options: {
  readonly dbPath: string;
  readonly now?: () => number;
}): LocalDevScheduleStore {
  const now = options.now ?? Date.now;
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = new DatabaseSync(options.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schedules (
      collection TEXT NOT NULL,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      expression_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      next_fire_at_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, namespace, name)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS schedules_next_fire ON schedules (next_fire_at_ms)
      WHERE state = 'active' AND next_fire_at_ms IS NOT NULL;
    CREATE TABLE IF NOT EXISTS operations (
      operation_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
  db.prepare("DELETE FROM operations WHERE created_at < ?").run(now() - OPERATION_RETENTION_MS);

  const select = db.prepare(
    "SELECT * FROM schedules WHERE collection = ? AND namespace = ? AND name = ?",
  );
  const selectAll = db.prepare(
    "SELECT * FROM schedules WHERE collection = ? AND namespace = ? ORDER BY name",
  );
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO schedules (collection, namespace, name, schedule_id, state,
      expression_json, payload_json, next_fire_at_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const del = db.prepare(
    "DELETE FROM schedules WHERE collection = ? AND namespace = ? AND name = ?",
  );
  const earliest = db.prepare(
    "SELECT MIN(next_fire_at_ms) AS next FROM schedules WHERE state = 'active' AND next_fire_at_ms IS NOT NULL",
  );
  const selectDue = db.prepare(
    "SELECT * FROM schedules WHERE state = 'active' AND next_fire_at_ms IS NOT NULL AND next_fire_at_ms <= ? ORDER BY next_fire_at_ms",
  );
  const selectOperation = db.prepare("SELECT result_json FROM operations WHERE operation_id = ?");
  const insertOperation = db.prepare(
    "INSERT INTO operations (operation_id, result_json, created_at) VALUES (?, ?, ?)",
  );
  const listeners = new Set<() => void>();

  const write = (row: LocalDevScheduleRow) =>
    upsert.run(
      row.collection,
      row.namespace,
      row.name,
      row.scheduleId,
      row.state,
      JSON.stringify(row.expression),
      JSON.stringify(row.payload),
      row.nextFireAtMs,
      row.createdAt,
      row.updatedAt,
    );
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    get: (collection, namespace, name) => {
      const found = select.get(collection, namespace, name);
      return found === undefined ? undefined : toRow(found);
    },
    list: (collection, namespace) => selectAll.all(collection, namespace).map(toRow),
    put: (row) => {
      write(row);
      notify();
    },
    remove: (collection, namespace, name) => {
      const removed = Number(del.run(collection, namespace, name).changes) > 0;
      notify();
      return removed;
    },
    earliestFireAtMs: () => {
      const { next } = earliest.get() as { next: number | null };
      return next;
    },
    claimDue: (nowMs) =>
      transaction(() =>
        selectDue.all(nowMs).map((found) => {
          const row = toRow(found);
          const scheduledAtMs = row.nextFireAtMs as number;
          const next = nextFireAtMs(row.expression, Math.max(nowMs, scheduledAtMs));
          write({
            ...row,
            nextFireAtMs: next,
            state: next === null ? "completed" : "active",
            updatedAt: nowMs,
          });
          return { row, scheduledAtMs };
        }),
      ),
    operation: <T>(operationId: string, run: () => T): T =>
      transaction(() => {
        const replay = selectOperation.get(operationId) as { result_json: string } | undefined;
        if (replay !== undefined) return JSON.parse(replay.result_json) as T;
        const result = run();
        insertOperation.run(operationId, JSON.stringify(result ?? null), now());
        return result;
      }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      listeners.clear();
      db.close();
    },
  };
}

export function sharedLocalDevScheduleStore(dbPath: string): LocalDevScheduleStore {
  const stores: Map<string, LocalDevScheduleStore> = ((
    globalThis as { [STORES]?: Map<string, LocalDevScheduleStore> }
  )[STORES] ??= new Map());
  let store = stores.get(dbPath);
  if (store === undefined) {
    const created = createLocalDevScheduleStore({ dbPath });
    store = {
      ...created,
      close: () => {
        stores.delete(dbPath);
        created.close();
      },
    };
    stores.set(dbPath, store);
  }
  return store;
}

function toRow(found: Record<string, unknown>): LocalDevScheduleRow {
  return {
    collection: found.collection as string,
    namespace: found.namespace as string,
    name: found.name as string,
    scheduleId: found.schedule_id as string,
    state: found.state as ScheduleState,
    expression: JSON.parse(found.expression_json as string) as ScheduleExpression,
    payload: JSON.parse(found.payload_json as string) as unknown,
    nextFireAtMs: found.next_fire_at_ms as number | null,
    createdAt: found.created_at as number,
    updatedAt: found.updated_at as number,
  };
}
