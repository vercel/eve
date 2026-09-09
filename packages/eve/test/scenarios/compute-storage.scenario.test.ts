import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresStorage,
  migrateComputeStorage,
  type ComputeMigration,
} from "../../src/compute/platform.js";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const composeFile = join(repositoryRoot, "apps/compute-platform/compose.yaml");
const workerEntrypoint = join(repositoryRoot, "apps/compute-platform/src/worker.ts");
const composeProject = `eve-compute-a1-${process.pid}`;

let postgresPort = 0;
let composeCommand: { command: string; prefix: string[] };

function databaseUrl(user: string, password: string, database: string): string {
  const url = new URL(`postgres://127.0.0.1:${postgresPort}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

function adminUrl(database = "eve_compute"): string {
  return databaseUrl("eve_compute_admin", "eve_compute_admin", database);
}

function migratorUrl(database: string): string {
  return databaseUrl("eve_compute_migrator", "eve_compute_migrator", database);
}

function runtimeUrl(database: string): string {
  return databaseUrl("eve_compute_runtime", "eve_compute_runtime", database);
}

function inspectorUrl(database: string): string {
  return databaseUrl("eve_compute_inspector", "eve_compute_inspector", database);
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address.");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function resolveComposeCommand(): Promise<{ command: string; prefix: string[] }> {
  try {
    await runFile("docker", ["compose", "version"]);
    return { command: "docker", prefix: ["compose"] };
  } catch {
    await runFile("docker-compose", ["version"]);
    return { command: "docker-compose", prefix: [] };
  }
}

async function compose(arguments_: string[]): Promise<void> {
  await runFile(
    composeCommand.command,
    [...composeCommand.prefix, "-f", composeFile, ...arguments_],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: composeProject,
        EVE_COMPUTE_POSTGRES_PORT: String(postgresPort),
      },
    },
  );
}

async function waitForPostgres(): Promise<void> {
  const storage = createPostgresStorage({
    applicationName: "eve-compute-scenario-wait",
    connectionString: adminUrl(),
    maxConnections: 1,
  });
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      try {
        await storage.query("SELECT 1");
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    await storage.close();
  }
}

interface ScenarioDatabase {
  name: string;
  admin: string;
  inspector: string;
  migrator: string;
  runtime: string;
}

async function createScenarioDatabase(): Promise<ScenarioDatabase> {
  const name = `compute_${randomUUID().replaceAll("-", "")}`;
  const storage = createPostgresStorage({
    applicationName: "eve-compute-scenario-admin",
    connectionString: adminUrl(),
    maxConnections: 1,
  });
  try {
    await storage.query(`CREATE DATABASE "${name}"`);
    await storage.query(`
      GRANT CONNECT ON DATABASE "${name}"
        TO eve_compute_migrator, eve_compute_runtime, eve_compute_inspector;
      GRANT CREATE ON DATABASE "${name}" TO eve_compute_migrator;
    `);
  } finally {
    await storage.close();
  }
  return {
    name,
    admin: adminUrl(name),
    inspector: inspectorUrl(name),
    migrator: migratorUrl(name),
    runtime: runtimeUrl(name),
  };
}

async function dropScenarioDatabase(database: ScenarioDatabase): Promise<void> {
  const storage = createPostgresStorage({
    applicationName: "eve-compute-scenario-cleanup",
    connectionString: adminUrl(),
    maxConnections: 1,
  });
  try {
    await storage.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database.name],
    );
    await storage.query(`DROP DATABASE IF EXISTS "${database.name}"`);
  } finally {
    await storage.close();
  }
}

async function withScenarioDatabase(
  operation: (database: ScenarioDatabase) => Promise<void>,
): Promise<void> {
  const database = await createScenarioDatabase();
  try {
    await operation(database);
  } finally {
    await dropScenarioDatabase(database);
  }
}

async function grantRuntimeAccess(database: ScenarioDatabase): Promise<void> {
  const storage = createPostgresStorage({
    applicationName: "eve-compute-scenario-grants",
    connectionString: database.admin,
    maxConnections: 1,
  });
  try {
    await storage.query(`
      GRANT USAGE ON SCHEMA compute TO eve_compute_runtime, eve_compute_inspector;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compute
        TO eve_compute_runtime;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA compute
        TO eve_compute_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA compute TO eve_compute_inspector;
      ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eve_compute_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO eve_compute_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
        GRANT SELECT ON TABLES TO eve_compute_inspector;
    `);
  } finally {
    await storage.close();
  }
}

function inlineMigration(version: number, name: string, sql: string): ComputeMigration {
  return { version, name, load: async () => sql };
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, "exit");
  worker.kill("SIGTERM");
  await exited;
}

async function waitForWorker(
  worker: ChildProcess,
): Promise<{ schemaVersion: number; workerId: string }> {
  const deadline = setTimeout(() => worker.kill("SIGKILL"), 15_000);
  let stdout = "";
  let stderr = "";
  worker.stdout?.setEncoding("utf8");
  worker.stderr?.setEncoding("utf8");
  worker.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  worker.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    while (worker.exitCode === null) {
      const line = stdout.split("\n").find((candidate) => candidate.includes('"status":"ready"'));
      if (line !== undefined) {
        return JSON.parse(line) as { schemaVersion: number; workerId: string };
      }
      await Promise.race([
        once(worker.stdout!, "data"),
        once(worker, "exit").then(() => undefined),
      ]);
    }
    throw new Error(`Worker exited before readiness.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    clearTimeout(deadline);
  }
}

beforeAll(async () => {
  postgresPort = await getAvailablePort();
  composeCommand = await resolveComposeCommand();
  await compose(["up", "-d", "postgres"]);
  await waitForPostgres();
}, 120_000);

afterAll(async () => {
  await compose(["down", "-v"]);
}, 120_000);

describe("compute PostgreSQL foundation", () => {
  it("applies the baseline and passes the reference constraint checks", async () => {
    await withScenarioDatabase(async (database) => {
      const storage = createPostgresStorage({
        applicationName: "eve-compute-scenario-baseline",
        connectionString: database.migrator,
        maxConnections: 2,
      });
      const concurrentStorage = createPostgresStorage({
        applicationName: "eve-compute-scenario-concurrent-baseline",
        connectionString: database.migrator,
        maxConnections: 1,
      });
      try {
        const concurrentResults = await Promise.all([
          migrateComputeStorage(storage),
          migrateComputeStorage(concurrentStorage),
        ]);
        expect(concurrentResults.map((result) => result.applied).sort()).toEqual([[], [1]]);
        await expect(migrateComputeStorage(storage)).resolves.toEqual({
          applied: [],
          currentVersion: 1,
        });

        const conformanceSource = await readFile(
          join(repositoryRoot, "research/compute-spec/schema.test.sql"),
          "utf8",
        );
        const executableSql = conformanceSource
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("\\"))
          .join("\n");
        await expect(storage.query(executableSql)).resolves.toBeDefined();

        await expect(
          storage.transaction(async (transaction) => {
            await transaction.query("CREATE TABLE compute.rollback_probe(value integer)");
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        await expect(
          storage.query<{ table_name: string | null }>(
            "SELECT to_regclass('compute.rollback_probe')::text AS table_name",
          ),
        ).resolves.toMatchObject({ rows: [{ table_name: null }] });
      } finally {
        await Promise.all([storage.close(), concurrentStorage.close()]);
      }
    });
  });

  it("upgrades a previous-version database and rejects changed migration bytes", async () => {
    await withScenarioDatabase(async (database) => {
      const storage = createPostgresStorage({
        applicationName: "eve-compute-scenario-upgrade",
        connectionString: database.migrator,
        maxConnections: 1,
      });
      const first = inlineMigration(
        1,
        "previous",
        `
          CREATE SCHEMA compute;
          CREATE TABLE compute.schema_migrations (
            version integer PRIMARY KEY CHECK (version > 0),
            checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
          );
          CREATE TABLE compute.migration_probe (value text NOT NULL);
        `,
      );
      const second = inlineMigration(
        2,
        "current",
        "ALTER TABLE compute.migration_probe ADD COLUMN revision integer NOT NULL DEFAULT 0;",
      );
      try {
        await expect(migrateComputeStorage(storage, [first])).resolves.toMatchObject({
          applied: [1],
        });
        await expect(migrateComputeStorage(storage, [first, second])).resolves.toEqual({
          applied: [2],
          currentVersion: 2,
        });
        await expect(
          storage.query("INSERT INTO compute.migration_probe(value, revision) VALUES ('ready', 2)"),
        ).resolves.toMatchObject({ rowCount: 1 });

        const changedFirst = inlineMigration(1, "previous", `${await first.load()}\n-- changed`);
        await expect(migrateComputeStorage(storage, [changedFirst, second])).rejects.toThrow(
          /Checksum mismatch/u,
        );
      } finally {
        await storage.close();
      }
    });
  });

  it("rolls back a failed baseline migration", async () => {
    await withScenarioDatabase(async (database) => {
      const storage = createPostgresStorage({
        applicationName: "eve-compute-scenario-failed-baseline",
        connectionString: database.migrator,
        maxConnections: 1,
      });
      const invalid = inlineMigration(
        1,
        "invalid",
        `
          CREATE SCHEMA compute;
          CREATE TABLE compute.schema_migrations (
            version integer PRIMARY KEY,
            checksum bytea NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
          );
          SELECT missing FROM compute.unknown_table;
        `,
      );
      try {
        await expect(migrateComputeStorage(storage, [invalid])).rejects.toThrow();
        await expect(
          storage.query<{ schema_name: string | null }>(
            "SELECT to_regnamespace('compute')::text AS schema_name",
          ),
        ).resolves.toMatchObject({ rows: [{ schema_name: null }] });
      } finally {
        await storage.close();
      }
    });
  });

  it("boots two workers with the runtime role and keeps inspection read-only", async () => {
    await withScenarioDatabase(async (database) => {
      const migrator = createPostgresStorage({
        applicationName: "eve-compute-scenario-workers",
        connectionString: database.migrator,
        maxConnections: 1,
      });
      await migrateComputeStorage(migrator);
      await migrator.close();
      await grantRuntimeAccess(database);

      const workers = ["scenario-a", "scenario-b"].map((workerId) =>
        spawn(process.execPath, ["--conditions=eve-source", workerEntrypoint, workerId], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            EVE_COMPUTE_RUNTIME_URL: database.runtime,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      try {
        await expect(Promise.all(workers.map(waitForWorker))).resolves.toEqual([
          { role: "supervisor", schemaVersion: 1, status: "ready", workerId: "scenario-a" },
          { role: "supervisor", schemaVersion: 1, status: "ready", workerId: "scenario-b" },
        ]);

        const inspector = createPostgresStorage({
          applicationName: "eve-compute-scenario-inspector",
          connectionString: database.inspector,
          maxConnections: 1,
        });
        try {
          await expect(
            inspector.query("SELECT count(*) AS count FROM compute.namespaces"),
          ).resolves.toMatchObject({ rows: [{ count: "0" }] });
          await expect(
            inspector.query(
              "INSERT INTO compute.namespaces(namespace_id, project_id) " +
                "VALUES ('00000000-0000-0000-0000-000000000001', 'forbidden')",
            ),
          ).rejects.toThrow();
        } finally {
          await inspector.close();
        }
      } finally {
        await Promise.all(workers.map(stopWorker));
      }
    });
  });
});
