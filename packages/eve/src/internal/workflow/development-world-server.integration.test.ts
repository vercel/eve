import { getDevelopmentFrameworkFingerprint } from "#internal/workflow/development-runtime-compatibility.js";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EntityConflictError, RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { activateDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { getDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";
import {
  createParentDevelopmentWorkflowWorld,
  type ParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-server.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#internal/workflow/development-world-protocol.js";

const createScratchDirectory = useTemporaryDirectories();
const SECRET = "workflow-transport-secret";
const RUN_ID = "wrun_01J00000000000000000000000";
const AGENT_NAME = "workflow-world-test";
const QUEUE_PREFIX = deriveEveWorkflowQueuePrefix(AGENT_NAME);
const LOCAL_DELIVERY_TIMEOUT_ENV_NAMES = [
  "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
  "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
] as const;
const originalLocalDeliveryTimeoutEnv = new Map(
  LOCAL_DELIVERY_TIMEOUT_ENV_NAMES.map((name) => [name, process.env[name]]),
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  delete process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  delete process.env.WORKFLOW_LOCAL_BASE_URL;
  for (const name of LOCAL_DELIVERY_TIMEOUT_ENV_NAMES) {
    const originalValue = originalLocalDeliveryTimeoutEnv.get(name);
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
});

describe("parent development Workflow World", () => {
  it("defaults local delivery timeouts to unbounded", async () => {
    for (const name of LOCAL_DELIVERY_TIMEOUT_ENV_NAMES) {
      delete process.env[name];
    }
    const appRoot = await createScratchDirectory("eve-parent-workflow-timeouts-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      expect(process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS).toBe("0");
      expect(process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS).toBe("0");
    } finally {
      await world.close();
    }
  });

  it("preserves explicit local delivery timeouts", async () => {
    process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = "123";
    process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = "456";
    const appRoot = await createScratchDirectory("eve-parent-workflow-explicit-timeouts-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      expect(process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS).toBe("123");
      expect(process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS).toBe("456");
    } finally {
      await world.close();
    }
  });

  it("stores local Workflow state under .eve/.workflow-data", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-data-dir-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      await world.start();
      await expect(
        access(join(resolveLocalWorkflowWorldDataDirectory(appRoot), "version.txt")),
      ).resolves.toBeUndefined();
      await expect(access(join(appRoot, ".workflow-data"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await world.close();
    }
  });

  it("keeps current-invocation deliveries eligible after authored workflow changes", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-world-");
    await seedGeneration(appRoot, "generation-a");
    await seedGeneration(appRoot, "generation-b");
    let activeGenerationId = "generation-a";
    const world = createWorld({ activeGenerationId: () => activeGenerationId, appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: workflowEntryReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 6,
        },
      ]);
      const runId = readCreatedRunId(created);

      await seedGeneration(appRoot, "generation-b", {
        workflowSourceFingerprint: "added-workflow",
      });
      activeGenerationId = "generation-b";
      for (const message of [
        { runId },
        { workflowRunId: runId },
        { runInput: { deploymentId: "generation-a" } },
        { runInput: { deploymentId: "generation-b" } },
      ]) {
        await expect(deliverToWorker(message)).resolves.toBe(
          message.runInput?.deploymentId ?? "generation-a",
        );
      }
    } finally {
      await world.close();
    }
  });

  it("honors exact run input generations and rejects untrusted deliveries", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-routing-");
    await seedGeneration(appRoot, "generation-a");
    await seedGeneration(appRoot, "generation-b");
    const world = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      await expect(
        deliverToWorker({
          runId: RUN_ID,
          runInput: {
            deploymentId: "generation-a",
            input: new Uint8Array(),
            specVersion: 6,
            workflowName: workflowEntryReference.workflowId,
          },
        }),
      ).resolves.toBe("generation-a");

      const untrusted = await createWorkerQueueHandler()(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId: RUN_ID }),
          headers: deliveryHeaders({ secret: "forged" }),
          method: "POST",
        }),
      );
      expect(untrusted.status).toBe(401);
    } finally {
      await world.close();
    }
  });

  it("quietly cancels orphaned runs at startup and preserves their cancellation reason", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-missing-generation-");
    await seedGeneration(appRoot, "generation-a");
    const first = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    await first.start();
    const created = await callWorld(first, "events.create", [
      null,
      {
        eventData: {
          deploymentId: "generation-a",
          executionContext: {},
          input: new Uint8Array(),
          workflowName: workflowEntryReference.workflowId,
        },
        eventType: "run_created",
        specVersion: 6,
      },
    ]);
    await first.close();
    await rm(join(appRoot, ".eve", "dev-runtime", "snapshots", "generation-a"), {
      force: true,
      recursive: true,
    });

    const restarted = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(restarted.start()).resolves.toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
      const runId = readCreatedRunId(created);
      await expect(callWorld(restarted, "runs.get", [runId])).resolves.toMatchObject({
        status: "cancelled",
      });
      const events = await callWorld(restarted, "events.list", [{ runId }]);
      expect(events).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({
            eventType: "run_cancelled",
            eventData: { cancelReason: "Development runtime snapshot is no longer available" },
          }),
        ]),
      });
    } finally {
      errorSpy.mockRestore();
      await restarted.close();
    }
  });

  it("recovers retained runs across restarts without recovering cancelled orphans", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-recovery-");
    await seedGeneration(appRoot, "retained");
    await seedGeneration(appRoot, "incompatible", { frameworkFingerprint: "old-framework" });
    await seedGeneration(appRoot, "legacy", { frameworkFingerprint: undefined });
    await seedGeneration(appRoot, "queued-only", { workflowSourceFingerprint: "old-workflow" });
    await seedGeneration(appRoot, "changed-workflow", {
      workflowSourceFingerprint: "old-workflow",
    });
    for (const [generationId, source] of [
      ["invalid-json", '{"runtimeAppRoot":'],
      ["invalid-schema", JSON.stringify({ runtimeAppRoot: 42 })],
      [
        "invalid-fingerprint",
        JSON.stringify({ runtimeAppRoot: "/unused", frameworkFingerprint: 42 }),
      ],
    ] as const) {
      await seedGeneration(appRoot, generationId);
      await writeFile(
        join(appRoot, ".eve", "dev-runtime", "snapshots", generationId, "generation.json"),
        source,
      );
    }
    const first = createWorld({ activeGenerationId: () => "retained", appRoot });
    await first.start();
    const runIds: string[] = [];
    try {
      for (const deploymentId of [
        "retained",
        "missing",
        "incompatible",
        "legacy",
        "changed-workflow",
        "invalid-json",
        "invalid-schema",
        "invalid-fingerprint",
      ]) {
        runIds.push(
          readCreatedRunId(
            await callWorld(first, "events.create", [
              null,
              {
                eventType: "run_created",
                specVersion: 6,
                eventData: {
                  deploymentId,
                  executionContext: {},
                  input: new Uint8Array(),
                  workflowName: workflowEntryReference.workflowId,
                },
              },
            ]),
          ),
        );
      }
    } finally {
      await first.close();
    }
    const deliveries: string[] = [];
    process.env.WORKFLOW_LOCAL_BASE_URL = "http://eve-dev.local";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const message = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
        runId: string;
      };
      deliveries.push(message.runId);
      return Response.json({ ok: true });
    }) as typeof fetch;
    let activeGenerationId = "retained";
    const restarted = createWorld({ activeGenerationId: () => activeGenerationId, appRoot });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await restarted.start();
      await expect.poll(() => deliveries).toEqual([runIds[0]]);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('"invalid-json": Development generation metadata is invalid.'),
      );
      await expect(callWorld(restarted, "runs.get", [runIds[1]])).resolves.toMatchObject({
        status: "cancelled",
      });
      connectWorkerToWorld(restarted, appRoot);
      await seedGeneration(appRoot, "rebuilt", { workflowSourceFingerprint: "old-workflow" });
      activeGenerationId = "rebuilt";
      await expect(deliverToWorker({ runId: runIds[0] })).resolves.toBe("retained");
      for (const runId of runIds.slice(2)) {
        await expect(deliverToWorker({ runId })).resolves.toBeUndefined();
        await expect(deliverToWorker({ workflowRunId: runId })).resolves.toBeUndefined();
        await expect(callWorld(restarted, "runs.get", [runId])).resolves.toMatchObject({
          status: "pending",
        });
      }
      await expect(
        deliverToWorker({ runId: RUN_ID, runInput: { deploymentId: "queued-only" } }),
      ).resolves.toBeUndefined();
    } finally {
      warning.mockRestore();
      await restarted.close();
    }
  });

  it("reconciles after activation prunes snapshots, preserves retained runs, and skips cleanup after close", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-pruning-");
    await seedGeneration(appRoot, "old");
    await seedGeneration(appRoot, "retained");
    const world = createWorld({ activeGenerationId: () => "retained", appRoot });
    await world.start();
    const createRun = async (deploymentId: string) =>
      readCreatedRunId(
        await callWorld(world, "events.create", [
          null,
          {
            eventData: {
              deploymentId,
              executionContext: {},
              input: new Uint8Array(),
              workflowName: workflowEntryReference.workflowId,
            },
            eventType: "run_created",
            specVersion: 6,
          },
        ]),
      );
    try {
      const old = await createRun("old");
      const running = await createRun("old");
      await callWorld(world, "events.create", [
        running,
        { eventType: "run_started", specVersion: 6 },
      ]);
      const terminal = await createRun("old");
      await callWorld(world, "events.create", [
        terminal,
        { eventType: "run_completed", specVersion: 6, eventData: { output: new Uint8Array() } },
      ]);
      const retained = await createRun("retained");
      await writeFile(join(appRoot, ".eve", "dev-runtime", "snapshots", "old", "activated"), "");
      await writeFile(
        join(appRoot, ".eve", "dev-runtime", "snapshots", "old", "retired.json"),
        JSON.stringify({ retiredAt: 0 }),
      );
      for (let index = 0; index < 5; index++) {
        const generationId = `recent-${index}`;
        await seedGeneration(appRoot, generationId);
        const root = join(appRoot, ".eve", "dev-runtime", "snapshots", generationId);
        await writeFile(join(root, "activated"), "");
        await writeFile(join(root, "retired.json"), JSON.stringify({ retiredAt: Date.now() }));
      }
      const snapshotRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", "retained");
      const runtimeAppRoot = join(snapshotRoot, "source", "app");
      const compileRoot = join(runtimeAppRoot, ".eve", "compile");
      await mkdir(compileRoot, { recursive: true });
      await writeFile(
        join(compileRoot, "module-map.mjs"),
        "export const moduleMap = { nodes: {} };\n",
      );
      await writeFile(
        join(compileRoot, "authored-modules.json"),
        JSON.stringify({
          fingerprint: "test",
          moduleMap: "module-map.mjs",
          version: 3,
        }),
      );
      const reconciled = Promise.withResolvers<void>();
      await activateDevelopmentGeneration({
        appRoot,
        generation: {
          fingerprint: "test",
          runtimeAppRoot,
          snapshotRoot,
          snapshotSourceRoot: join(snapshotRoot, "source"),
          sourceRoot: appRoot,
        },
        onRuntimePruned: async () => {
          try {
            await world.reconcileExpiredRuns();
            reconciled.resolve();
          } catch (error) {
            reconciled.reject(error);
          }
        },
      });
      await reconciled.promise;
      for (const runId of [old, running]) {
        await expect(callWorld(world, "runs.get", [runId])).resolves.toMatchObject({
          status: "cancelled",
        });
      }
      await expect(callWorld(world, "runs.get", [terminal])).resolves.toMatchObject({
        status: "completed",
      });
      await expect(callWorld(world, "runs.get", [retained])).resolves.toMatchObject({
        status: "pending",
      });
      await world.close();
      await rm(join(appRoot, ".eve", "dev-runtime", "snapshots", "retained"), { recursive: true });
      await world.reconcileExpiredRuns();
      await expect(callWorld(world, "runs.get", [retained])).resolves.toMatchObject({
        status: "pending",
      });
    } finally {
      await world.close();
    }
  });

  it("routes a pre-start health check to the active generation before its run exists", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-health-check-");
    await seedGeneration(appRoot, "generation-b");
    const world = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      const payload = { __healthCheck: true, correlationId: "probe", runId: RUN_ID };
      const handled = vi.fn(async () => {
        expect(getDevelopmentWorkflowGeneration()?.generationId).toBe("generation-b");
      });
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const response = await handler(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify(payload),
          headers: {
            ...deliveryHeaders({}),
            "x-vqs-queue-name": `${QUEUE_PREFIX}health_check`,
          },
          method: "POST",
        }),
      );
      expect(response.status, await response.text()).toBe(200);
      expect(handled).toHaveBeenCalledWith(payload, expect.any(Object));
    } finally {
      await world.close();
    }
  });

  it("acknowledges and drops a delivery whose generation is permanently missing", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-dropped-delivery-");
    await seedGeneration(appRoot, "generation-a");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: workflowEntryReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 6,
        },
      ]);
      const runId = readCreatedRunId(created);
      await rm(join(appRoot, ".eve", "dev-runtime", "snapshots", "generation-a"), {
        force: true,
        recursive: true,
      });

      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const response = await handler(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId }),
          headers: deliveryHeaders({}),
          method: "POST",
        }),
      );

      // A missing generation never heals on retry: the delivery is
      // acknowledged so the queue stops redelivering, and the handler
      // never runs.
      expect(response.status).toBe(200);
      expect(handled).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      await expect(callWorld(world, "runs.get", [runId])).resolves.toMatchObject({
        status: "cancelled",
      });
    } finally {
      errorSpy.mockRestore();
      await world.close();
    }
  });

  it("acknowledges stale deliveries whose run no longer exists", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-missing-run-");
    await seedGeneration(appRoot, "generation-a");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);
    try {
      await world.start();
      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      for (const payload of [
        { runId: RUN_ID },
        { workflowRunId: RUN_ID },
        { runId: RUN_ID, runInput: { deploymentId: "missing" } },
      ]) {
        const response = await handler(
          new Request("http://localhost/.well-known/workflow/v1/flow", {
            body: JSON.stringify(payload),
            headers: deliveryHeaders({}),
            method: "POST",
          }),
        );
        expect(response.status, await response.text()).toBe(200);
      }
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await world.close();
    }
  });

  it.each([
    { error: new RunExpiredError("run expired"), status: 200 },
    { error: new EntityConflictError("storage conflict"), status: 500 },
    { error: new Error("storage unavailable"), status: 500 },
  ])("returns $status when delivery run lookup fails with $error", async ({ error, status }) => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-run-lookup-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(encodeDevelopmentWorldValue(serializeDevelopmentWorldError(error)), {
          status: 500,
        }),
    );
    try {
      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const response = await handler(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId: RUN_ID }),
          headers: deliveryHeaders({}),
          method: "POST",
        }),
      );
      expect(response.status).toBe(status);
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await world.close();
    }
  });

  it("retries a delivery when generation metadata is temporarily unreadable", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-retry-delivery-");
    await seedGeneration(appRoot, "generation-a");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: workflowEntryReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 6,
        },
      ]);
      const runId = readCreatedRunId(created);
      const metadataPath = join(
        appRoot,
        ".eve",
        "dev-runtime",
        "snapshots",
        "generation-a",
        "generation.json",
      );
      await rm(metadataPath);
      await mkdir(metadataPath);

      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const createDelivery = () =>
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId }),
          headers: deliveryHeaders({}),
          method: "POST",
        });

      const failed = await handler(createDelivery());
      expect(failed.status).toBe(500);
      expect(handled).not.toHaveBeenCalled();

      await rm(metadataPath, { recursive: true });
      await seedGeneration(appRoot, "generation-a");
      const retried = await handler(createDelivery());
      expect(retried.status).toBe(200);
      expect(handled).toHaveBeenCalledOnce();
    } finally {
      await world.close();
    }
  });

  it("rejects untrusted World requests on the call and stream routes", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-untrusted-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      const missingHeader = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
          body: encodeDevelopmentWorldValue({ arguments: [], operation: "runs.list" }),
          method: "POST",
        }),
      );
      expect(missingHeader?.status).toBe(401);

      const forgedHeader = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
          body: encodeDevelopmentWorldValue({ arguments: [], operation: "runs.list" }),
          headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: "forged" },
          method: "POST",
        }),
      );
      expect(forgedHeader?.status).toBe(401);

      const stream = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_STREAM_ROUTE}?runId=r&name=n`),
      );
      expect(stream?.status).toBe(401);
    } finally {
      await world.close();
    }
  });

  it("refuses a transport secret too short to be trusted", () => {
    expect(() =>
      createParentDevelopmentWorkflowWorld({
        agentName: AGENT_NAME,
        appRoot: "/tmp/eve-test",
        resolveActiveGenerationId: () => "generation-a",
        transportSecret: "",
      }),
    ).toThrow("too short");
  });
});

/**
 * Wires the worker-side world client to the parent world in memory: the
 * client's fetches route straight into `world.handleRequest`, standing in for
 * the parent listener without binding a port.
 */
function connectWorkerToWorld(world: ParentDevelopmentWorkflowWorld, appRoot: string): void {
  process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = SECRET;
  process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;
  process.env.WORKFLOW_LOCAL_BASE_URL = "http://eve-dev.local";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await world.handleRequest(request);
    if (response === undefined) {
      throw new Error(`Unexpected fetch during test: ${request.url}`);
    }
    return response;
  }) as typeof fetch;
}

function createWorkerQueueHandler(): (request: Request) => Promise<Response> {
  const worker = createDevelopmentWorkflowWorld();
  const handler = worker.createQueueHandler(QUEUE_PREFIX, async () => undefined);
  return handler;
}

/**
 * Runs one queue delivery through the worker-side handler and reports the
 * generation the handler executed under.
 */
async function deliverToWorker(payload: unknown): Promise<string | undefined> {
  const worker = createDevelopmentWorkflowWorld();
  let observedGenerationId: string | undefined;
  const handler = worker.createQueueHandler(QUEUE_PREFIX, async () => {
    observedGenerationId = getDevelopmentWorkflowGeneration()?.generationId;
  });
  const response = await handler(
    new Request("http://localhost/.well-known/workflow/v1/flow", {
      body: JSON.stringify(payload),
      headers: deliveryHeaders({}),
      method: "POST",
    }),
  );
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return observedGenerationId;
}

function deliveryHeaders(input: { readonly secret?: string }): Record<string, string> {
  return {
    [DEVELOPMENT_WORKFLOW_DELIVERY_HEADER]: input.secret ?? SECRET,
    "x-vqs-message-attempt": "1",
    "x-vqs-message-id": "msg_test",
    "x-vqs-queue-name": `${QUEUE_PREFIX}${workflowEntryReference.workflowId}`,
  };
}

async function seedGeneration(
  appRoot: string,
  generationId: string,
  overrides: { frameworkFingerprint?: string | undefined; workflowSourceFingerprint?: string } = {},
): Promise<void> {
  const snapshotRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", generationId);
  const runtimeAppRoot = join(snapshotRoot, "source", "app");
  await mkdir(runtimeAppRoot, { recursive: true });
  await writeFile(
    join(snapshotRoot, "generation.json"),
    `${JSON.stringify({ runtimeAppRoot, frameworkFingerprint: await getDevelopmentFrameworkFingerprint(), ...overrides })}\n`,
  );
}

function readCreatedRunId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof value.run === "object" &&
    value.run !== null &&
    "runId" in value.run &&
    typeof value.run.runId === "string"
  ) {
    return value.run.runId;
  }
  throw new Error("Workflow World did not return the created run ID.");
}

function createWorld(input: {
  readonly activeGenerationId: () => string;
  readonly appRoot: string;
}): ParentDevelopmentWorkflowWorld {
  return createParentDevelopmentWorkflowWorld({
    agentName: AGENT_NAME,
    appRoot: input.appRoot,
    resolveActiveGenerationId: input.activeGenerationId,
    transportSecret: SECRET,
  });
}

async function callWorld(
  world: ParentDevelopmentWorkflowWorld,
  operation: string,
  args: readonly unknown[],
): Promise<unknown> {
  const response = await world.handleRequest(
    new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
      body: encodeDevelopmentWorldValue({ arguments: args, operation }),
      headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: SECRET },
      method: "POST",
    }),
  );
  expect(response).toBeDefined();
  const body = await response!.text();
  expect(response!.status, body).toBe(200);
  return decodeDevelopmentWorldValue(body);
}
