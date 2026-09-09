import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ComputeQueryExecutor, ComputeStorage } from "#compute/storage/types.js";

export interface ComputeMigration {
  version: number;
  name: string;
  load(): Promise<string>;
}

export interface ComputeMigrationResult {
  applied: number[];
  currentVersion: number;
}

export const COMPUTE_SCHEMA_MIGRATIONS: readonly ComputeMigration[] = [
  {
    version: 1,
    name: "baseline",
    load: () => readFile(new URL("./migrations/0001_baseline.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    name: "cell_quarantine_reason",
    load: () =>
      readFile(new URL("./migrations/0002_cell_quarantine_reason.sql", import.meta.url), "utf8"),
  },
];

// Serialize schema changes without holding a lock beyond the migration transaction.
const COMPUTE_MIGRATION_LOCK_ID = 7_205_756_879_026_213_997n;

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function validateMigrations(migrations: readonly ComputeMigration[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error(
        `Compute migrations must be contiguous from version 1; expected ${expected}, received ${migration.version}.`,
      );
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(migration.name)) {
      throw new Error(`Invalid compute migration name "${migration.name}".`);
    }
    expected++;
  }
}

function assertNoTransactionControl(sql: string, migration: ComputeMigration): void {
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/imu.test(sql)) {
    throw new Error(
      `Compute migration ${migration.version}_${migration.name} contains transaction control; the runner owns its transaction.`,
    );
  }
}

async function readAppliedMigrations(
  storage: ComputeQueryExecutor,
): Promise<{ checksum: string; version: number }[] | null> {
  const presence = await storage.query<{
    migration_table: string | null;
    schema_name: string | null;
  }>(
    "SELECT to_regnamespace('compute')::text AS schema_name, " +
      "to_regclass('compute.schema_migrations')::text AS migration_table",
  );
  const row = presence.rows[0];
  if (row?.schema_name === null) {
    return null;
  }
  if (row === undefined || row.migration_table === null) {
    throw new Error(
      "The compute schema exists without compute.schema_migrations; refusing to adopt an unmanaged database.",
    );
  }

  const applied = await storage.query<{ checksum: string; version: number }>(
    "SELECT version, encode(checksum, 'hex') AS checksum " +
      "FROM compute.schema_migrations ORDER BY version",
  );
  if (applied.rows.length === 0) {
    throw new Error(
      "The compute schema has no recorded migrations; refusing to adopt an incomplete database.",
    );
  }
  return applied.rows;
}

export async function migrateComputeStorage(
  storage: ComputeStorage,
  migrations: readonly ComputeMigration[] = COMPUTE_SCHEMA_MIGRATIONS,
): Promise<ComputeMigrationResult> {
  validateMigrations(migrations);
  const loaded = await Promise.all(
    migrations.map(async (migration) => {
      const sql = await migration.load();
      assertNoTransactionControl(sql, migration);
      return { ...migration, checksum: checksum(sql), sql };
    }),
  );

  return storage.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [COMPUTE_MIGRATION_LOCK_ID]);
    const recorded = await readAppliedMigrations(transaction);
    const appliedCount = recorded?.length ?? 0;
    for (let index = 0; index < appliedCount; index++) {
      const actual = recorded?.[index];
      const expected = loaded[index];
      if (actual === undefined || expected === undefined || actual.version !== expected.version) {
        throw new Error(
          `Database records unknown compute migration version ${actual?.version ?? "missing"}.`,
        );
      }
      if (actual.checksum !== expected.checksum) {
        throw new Error(
          `Checksum mismatch for compute migration ${expected.version}_${expected.name}.`,
        );
      }
    }

    const applied: number[] = [];
    for (const migration of loaded.slice(appliedCount)) {
      await transaction.query(migration.sql);
      await transaction.query(
        "INSERT INTO compute.schema_migrations(version, checksum) VALUES ($1, decode($2, 'hex'))",
        [migration.version, migration.checksum],
      );
      applied.push(migration.version);
    }

    return {
      applied,
      currentVersion: loaded.at(-1)?.version ?? 0,
    };
  });
}

export async function readComputeSchemaVersion(storage: ComputeQueryExecutor): Promise<number> {
  const result = await storage.query<{ version: number | null }>(
    "SELECT max(version) AS version FROM compute.schema_migrations",
  );
  return result.rows[0]?.version ?? 0;
}

export async function assertComputeSchemaReady(storage: ComputeQueryExecutor): Promise<number> {
  const expected = COMPUTE_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
  const actual = await readComputeSchemaVersion(storage);
  if (actual !== expected) {
    throw new Error(`Compute schema version ${actual} is not ready; expected ${expected}.`);
  }
  return actual;
}
