import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ComputeClient, defineCell } from "../../src/compute/index.js";
import {
  COMPUTE_SCHEMA_MIGRATIONS,
  admitMessage,
  commitCellTransition,
  createComputeAuthenticator,
  createComputeGatewayServer,
  createComputeHttpHandler,
  createPostgresStorage,
  decodeWireValue,
  encodeWireValue,
  executeCellTransition,
  hashComputeCredential,
  migrateComputeStorage,
  prepareCellTransition,
  readCellEvents,
  readCellView,
  type ComputeMigration,
  type ComputeFailpoints,
  type ComputeStorage,
  type LeaseToken,
} from "../../src/compute/platform.js";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const composeFile = join(repositoryRoot, "apps/compute-platform/compose.yaml");
const workerEntrypoint = join(repositoryRoot, "apps/compute-platform/src/worker.ts");
const composeProject = `eve-compute-a1-${process.pid}`;
const CELL_DEFINITION_ID = "cells/counter";
const EFFECT_DEFINITION_ID = "effects/log";
const DEPLOYMENT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const MANIFEST_DIGEST = `sha256:${"b".repeat(64)}` as const;

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

interface CounterState {
  sequences: string[];
  total: number;
}

interface CounterMessage {
  operations?: boolean;
  value: number;
}

function parseCounterState(value: unknown): CounterState {
  if (
    value === null ||
    typeof value !== "object" ||
    !("sequences" in value) ||
    !Array.isArray(value.sequences) ||
    !value.sequences.every((sequence) => typeof sequence === "string") ||
    !("total" in value) ||
    typeof value.total !== "number"
  ) {
    throw new Error("Invalid counter state.");
  }
  return { sequences: [...value.sequences], total: value.total };
}

function parseCounterMessage(value: unknown): CounterMessage {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid counter message.");
  }
  const candidate = value as { operations?: unknown; value?: unknown };
  if (
    typeof candidate.value !== "number" ||
    (candidate.operations !== undefined && typeof candidate.operations !== "boolean")
  ) {
    throw new Error("Invalid counter message.");
  }
  return typeof candidate.operations === "boolean"
    ? { value: candidate.value, operations: candidate.operations }
    : { value: candidate.value };
}

function counterDefinitionForNamespace(namespaceId: string) {
  return defineCell<CounterState, CounterMessage>({
    stateVersion: 1,
    messageVersion: 1,
    stateSchema: { parse: parseCounterState },
    messageSchema: { parse: parseCounterMessage },
    initial: () => ({ sequences: [], total: 0 }),
    receive(state, message, context) {
      if ("kind" in message) throw new Error("Unexpected system message.");
      const next = {
        sequences: [...state.sequences, context.sequence],
        total: state.total + message.value,
      };
      if (!message.operations) return { state: next };
      return {
        state: next,
        effects: [
          {
            key: "effect",
            definition: EFFECT_DEFINITION_ID,
            inputVersion: 1,
            input: { value: next.total },
          },
        ],
        sends: [
          {
            key: "send",
            destination: {
              namespaceId,
              definition: CELL_DEFINITION_ID,
              key: "sink",
            },
            messageVersion: 1,
            message: { value: next.total },
          },
        ],
        timers: [
          {
            action: "set",
            key: "wake",
            deadline: "2026-09-10T00:00:00Z",
            messageVersion: 1,
            message: { value: 0 },
          },
        ],
        events: [{ key: "applied", value: { total: next.total } }],
      };
    },
    migrateState: (_version, value) => parseCounterState(value),
    migrateMessage: (_version, value) => parseCounterMessage(value),
  });
}

function deploymentManifest() {
  return {
    protocol: 1,
    image: DEPLOYMENT_DIGEST,
    artifactManifestHash: MANIFEST_DIGEST,
    definitions: [
      {
        id: CELL_DEFINITION_ID,
        kind: "cell",
        module: "cells/counter.ts",
        export: "default",
        inputVersion: 1,
        stateVersion: 1,
        outputVersion: null,
        retry: null,
      },
      {
        id: EFFECT_DEFINITION_ID,
        kind: "effect",
        module: "effects/log.ts",
        export: "default",
        inputVersion: 1,
        stateVersion: null,
        outputVersion: 1,
        retry: { mode: "manual", timeoutMs: 120_000 },
      },
    ],
  };
}

async function setupA2Database(database: ScenarioDatabase): Promise<{
  namespaceId: string;
  storage: ComputeStorage;
}> {
  const migrator = createPostgresStorage({
    applicationName: "eve-compute-a2-migrator",
    connectionString: database.migrator,
    maxConnections: 2,
  });
  const namespaceId = randomUUID();
  try {
    await migrateComputeStorage(migrator);
    await migrator.query(
      "INSERT INTO compute.namespaces(namespace_id, project_id) VALUES ($1, 'a2-scenario')",
      [namespaceId],
    );
    await migrator.query("INSERT INTO compute.namespace_usage(namespace_id) VALUES ($1)", [
      namespaceId,
    ]);
    await migrator.query(
      "INSERT INTO compute.deployments(" +
        "namespace_id, digest, manifest, manifest_hash, status" +
        ") VALUES ($1, $2, $3::jsonb, $4, 'ready')",
      [namespaceId, DEPLOYMENT_DIGEST, JSON.stringify(deploymentManifest()), MANIFEST_DIGEST],
    );
    await migrator.query(
      "UPDATE compute.namespaces SET desired_deployment = $2, deployment_epoch = 1 " +
        "WHERE namespace_id = $1",
      [namespaceId, DEPLOYMENT_DIGEST],
    );
  } finally {
    await migrator.close();
  }
  await grantRuntimeAccess(database);
  return {
    namespaceId,
    storage: createPostgresStorage({
      applicationName: "eve-compute-a2-runtime",
      connectionString: database.runtime,
      maxConnections: 32,
    }),
  };
}

async function leaseCell(
  storage: ComputeStorage,
  namespaceId: string,
  cellId: string,
): Promise<LeaseToken> {
  const workerId = randomUUID();
  const assignmentId = randomUUID();
  await storage.query(
    "INSERT INTO compute.workers(" +
      "namespace_id, worker_id, deployment_digest, status, heartbeat_at, cell_slots, effect_slots" +
      ") VALUES ($1, $2, $3, 'ready', clock_timestamp(), 1, 0)",
    [namespaceId, workerId, DEPLOYMENT_DIGEST],
  );
  const result = await storage.query<{
    generation: string;
    lease_epoch: string;
  }>(
    "UPDATE compute.cells SET owner_id = $3, assignment_id = $4, " +
      "lease_epoch = lease_epoch + 1, lease_until = clock_timestamp() + interval '5 minutes', " +
      "ready_at = NULL WHERE namespace_id = $1 AND cell_id = $2 " +
      "RETURNING generation, lease_epoch",
    [namespaceId, cellId, workerId, assignmentId],
  );
  const cell = result.rows[0];
  if (cell === undefined) throw new Error("Cell lease fixture did not find the cell.");
  return {
    resourceId: cellId,
    assignmentId,
    ownerId: workerId,
    epoch: cell.lease_epoch as LeaseToken["epoch"],
    cancellationGeneration: cell.generation as LeaseToken["cancellationGeneration"],
    deployment: DEPLOYMENT_DIGEST,
  };
}

function failOnce(name: Parameters<ComputeFailpoints["hit"]>[0]): ComputeFailpoints {
  let pending = true;
  return {
    async hit(candidate) {
      if (pending && candidate === name) {
        pending = false;
        throw new Error(`failpoint:${name}`);
      }
    },
  };
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
        expect(concurrentResults.map((result) => result.applied).sort()).toEqual([[], [1, 2]]);
        await expect(migrateComputeStorage(storage)).resolves.toEqual({
          applied: [],
          currentVersion: 2,
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
      const first = COMPUTE_SCHEMA_MIGRATIONS[0];
      const second = COMPUTE_SCHEMA_MIGRATIONS[1];
      if (first === undefined || second === undefined) {
        throw new Error("Expected the A2 production migration chain.");
      }
      try {
        await expect(migrateComputeStorage(storage, [first])).resolves.toEqual({
          applied: [1],
          currentVersion: 1,
        });
        await expect(migrateComputeStorage(storage, COMPUTE_SCHEMA_MIGRATIONS)).resolves.toEqual({
          applied: [2],
          currentVersion: 2,
        });
        await expect(
          storage.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns " +
              "WHERE table_schema = 'compute' AND table_name = 'cells' " +
              "AND column_name = 'quarantine_reason'",
          ),
        ).resolves.toMatchObject({
          rows: [{ column_name: "quarantine_reason" }],
        });

        const changedFirst = inlineMigration(1, first.name, `${await first.load()}\n-- changed`);
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
          { role: "supervisor", schemaVersion: 2, status: "ready", workerId: "scenario-a" },
          { role: "supervisor", schemaVersion: 2, status: "ready", workerId: "scenario-b" },
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

describe("compute A2 admission and fenced transitions", () => {
  it("orders one application per unique ID across 1,000 concurrent sends", async () => {
    await withScenarioDatabase(async (database) => {
      const { namespaceId, storage } = await setupA2Database(database);
      try {
        const message = { version: 1, value: encodeWireValue({ value: 1 }) };
        const receipts = await Promise.all(
          Array.from({ length: 1000 }, (_, index) =>
            admitMessage(storage, {
              namespaceId,
              principalId: "scenario-sender",
              request: {
                address: { definition: CELL_DEFINITION_ID, key: "ordered" },
                message,
                idempotencyKey: `delivery-${index % 100}`,
              },
            }),
          ),
        );

        expect(new Set(receipts.map((receipt) => receipt.messageId)).size).toBe(100);
        for (let key = 0; key < 100; key++) {
          const group = receipts.filter((_, index) => index % 100 === key);
          expect(new Set(group.map((receipt) => receipt.messageId)).size).toBe(1);
          expect(new Set(group.map((receipt) => receipt.sequence)).size).toBe(1);
        }

        const cellId = receipts[0]!.cellId;
        const orderedSequences = [...new Set(receipts.map((receipt) => BigInt(receipt.sequence)))]
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map(String);
        expect(orderedSequences).toEqual(
          Array.from({ length: 100 }, (_, index) => String(index + 1)),
        );

        const token = await leaseCell(storage, namespaceId, cellId);
        const definition = counterDefinitionForNamespace(namespaceId);
        for (let sequence = 1; sequence <= 100; sequence++) {
          await executeCellTransition({
            command: {
              commandSequence: String(sequence) as LeaseToken["epoch"],
              requestId: randomUUID(),
            },
            definition,
            definitionId: CELL_DEFINITION_ID,
            namespaceId,
            storage,
            token,
          });
        }

        const view = await readCellView(storage, namespaceId, cellId);
        expect(view.revision).toBe("100");
        expect(view.state).not.toBeNull();
        const state = parseCounterState(decodeWireValue(view.state!.value));
        expect(state.total).toBe(100);
        expect(state.sequences).toEqual(
          Array.from({ length: 100 }, (_, index) => String(index + 1)),
        );
        await expect(
          storage.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM compute.messages " +
              "WHERE namespace_id = $1 AND cell_id = $2 AND status = 'applied'",
            [namespaceId, cellId],
          ),
        ).resolves.toMatchObject({ rows: [{ count: "100" }] });
      } finally {
        await storage.close();
      }
    });
  }, 120_000);

  it("survives admission and transition failures on both sides of commit", async () => {
    await withScenarioDatabase(async (database) => {
      const { namespaceId, storage } = await setupA2Database(database);
      try {
        const definition = counterDefinitionForNamespace(namespaceId);
        const request = {
          address: { definition: CELL_DEFINITION_ID, key: "crash" },
          message: {
            version: 1,
            value: encodeWireValue({ operations: true, value: 5 }),
          },
          idempotencyKey: "crash-delivery",
        };

        await expect(
          admitMessage(storage, {
            failpoints: failOnce("admission.before_commit"),
            namespaceId,
            principalId: "scenario-sender",
            request: { ...request, idempotencyKey: "before-commit" },
          }),
        ).rejects.toThrow("failpoint:admission.before_commit");
        await expect(
          storage.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM compute.messages WHERE namespace_id = $1",
            [namespaceId],
          ),
        ).resolves.toMatchObject({ rows: [{ count: "0" }] });

        await expect(
          admitMessage(storage, {
            failpoints: failOnce("admission.after_commit"),
            namespaceId,
            principalId: "scenario-sender",
            request,
          }),
        ).rejects.toThrow("failpoint:admission.after_commit");
        const receipt = await admitMessage(storage, {
          namespaceId,
          principalId: "scenario-sender",
          request,
        });
        expect(receipt.sequence).toBe("1");

        const token = await leaseCell(storage, namespaceId, receipt.cellId);
        const prepared = await prepareCellTransition({
          definition,
          definitionId: CELL_DEFINITION_ID,
          namespaceId,
          storage,
          token,
        });
        const command = {
          commandSequence: "1" as const,
          requestId: randomUUID(),
        };
        await expect(
          commitCellTransition({
            command,
            failpoints: failOnce("transition.before_commit"),
            prepared,
            storage,
          }),
        ).rejects.toThrow("failpoint:transition.before_commit");
        await expect(
          storage.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM compute.effects WHERE namespace_id = $1",
            [namespaceId],
          ),
        ).resolves.toMatchObject({ rows: [{ count: "0" }] });
        expect((await readCellView(storage, namespaceId, receipt.cellId)).state).toBeNull();

        await expect(
          commitCellTransition({
            command,
            failpoints: failOnce("transition.after_commit"),
            prepared,
            storage,
          }),
        ).rejects.toThrow("failpoint:transition.after_commit");
        await storage.query(
          "UPDATE compute.cells SET owner_id = NULL, assignment_id = NULL, lease_until = NULL " +
            "WHERE namespace_id = $1 AND cell_id = $2",
          [namespaceId, receipt.cellId],
        );
        await expect(commitCellTransition({ command, prepared, storage })).resolves.toEqual({
          control: "continue",
          revision: "1",
        });

        for (const table of ["effects", "outbox", "timers", "events"]) {
          await expect(
            storage.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM compute.${table} WHERE namespace_id = $1`,
              [namespaceId],
            ),
          ).resolves.toMatchObject({ rows: [{ count: "1" }] });
        }
        const events = await readCellEvents(storage, namespaceId, receipt.cellId, 0n, 100);
        expect(events).toHaveLength(1);
        expect(decodeWireValue(events[0]!.value)).toEqual({ total: 5 });
        const view = await readCellView(storage, namespaceId, receipt.cellId);
        expect(view.revision).toBe("1");
        expect(parseCounterState(decodeWireValue(view.state!.value))).toMatchObject({
          total: 5,
        });
      } finally {
        await storage.close();
      }
    });
  });

  it("rejects stale commits, quarantines poison messages, and enforces HTTP access", async () => {
    await withScenarioDatabase(async (database) => {
      const { namespaceId, storage } = await setupA2Database(database);
      try {
        const definition = counterDefinitionForNamespace(namespaceId);
        const staleReceipt = await admitMessage(storage, {
          namespaceId,
          principalId: "scenario-sender",
          request: {
            address: { definition: CELL_DEFINITION_ID, key: "stale" },
            message: { version: 1, value: encodeWireValue({ value: 1 }) },
            idempotencyKey: "stale-delivery",
          },
        });
        const staleToken = await leaseCell(storage, namespaceId, staleReceipt.cellId);
        const stalePrepared = await prepareCellTransition({
          definition,
          definitionId: CELL_DEFINITION_ID,
          namespaceId,
          storage,
          token: staleToken,
        });
        await storage.query(
          "UPDATE compute.cells SET lease_epoch = lease_epoch + 1 " +
            "WHERE namespace_id = $1 AND cell_id = $2",
          [namespaceId, staleReceipt.cellId],
        );
        await expect(
          commitCellTransition({
            command: { commandSequence: "1", requestId: randomUUID() },
            prepared: stalePrepared,
            storage,
          }),
        ).rejects.toMatchObject({ code: "STALE_EXECUTION" });

        const poisonToken = await leaseCell(storage, namespaceId, staleReceipt.cellId);
        const poisonDefinition = defineCell<CounterState, CounterMessage>({
          ...definition,
          receive() {
            throw new Error("private handler detail");
          },
        });
        await expect(
          prepareCellTransition({
            definition: poisonDefinition,
            definitionId: CELL_DEFINITION_ID,
            namespaceId,
            storage,
            token: poisonToken,
          }),
        ).rejects.toMatchObject({
          code: "INVALID_INPUT",
          message: "Cell transition handler failed.",
        });
        await expect(
          storage.query<{ status: string }>(
            "SELECT status FROM compute.cells WHERE namespace_id = $1 AND cell_id = $2",
            [namespaceId, staleReceipt.cellId],
          ),
        ).resolves.toMatchObject({ rows: [{ status: "quarantined" }] });
        await expect(
          storage.query<{ quarantine_reason: unknown }>(
            "SELECT quarantine_reason FROM compute.cells " +
              "WHERE namespace_id = $1 AND cell_id = $2",
            [namespaceId, staleReceipt.cellId],
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              quarantine_reason: {
                code: "INVALID_INPUT",
                message: "Cell transition handler failed.",
                messageId: staleReceipt.messageId,
              },
            },
          ],
        });

        const token = "0123456789abcdef0123456789abcdef";
        const handler = createComputeHttpHandler({
          authenticator: createComputeAuthenticator([
            {
              credentialHash: hashComputeCredential(token),
              namespaceId,
              permissions: ["send", "read"],
              principalId: "http-client",
            },
          ]),
          storage,
        });
        const gateway = createComputeGatewayServer(handler);
        const endpoint = await gateway.listen(0);
        try {
          const client = new ComputeClient({ endpoint, namespaceId, token });
          const receipt = await client.send(
            { definition: CELL_DEFINITION_ID, key: "http" },
            { version: 1, value: { value: 2 } },
            { idempotencyKey: "http-delivery" },
          );
          await expect(client.readReceipt(receipt.messageId)).resolves.toEqual(receipt);
          await expect(client.readState(receipt.cellId)).resolves.toMatchObject({
            cellId: receipt.cellId,
            state: null,
          });
          await expect(client.readNamespace()).resolves.toMatchObject({
            namespaceId,
            deploymentEpoch: "1",
          });
          await expect(
            client.send(
              { definition: CELL_DEFINITION_ID, key: "http" },
              { version: 1, value: { value: 3 } },
              { idempotencyKey: "http-delivery" },
            ),
          ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
          const forged = new ComputeClient({
            endpoint,
            namespaceId: randomUUID(),
            token,
          });
          await expect(forged.readNamespace()).rejects.toMatchObject({
            code: "UNAUTHORIZED",
          });
          await expect(
            client.send(
              { definition: CELL_DEFINITION_ID, key: "large" },
              { version: 1, value: { text: "x".repeat(300_000), value: 1 } },
              { idempotencyKey: "large-delivery" },
            ),
          ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        } finally {
          await gateway.close();
        }
      } finally {
        await storage.close();
      }
    });
  });
});
