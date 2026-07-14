import type {
  MessageId,
  QueuePrefix,
  SpecVersion,
  ValidQueueName,
  World,
} from "#compiled/@workflow/world/index.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { turnWorkflowReference } from "#execution/workflow-runtime.js";
import {
  decodeDevelopmentWorldJson,
  decodeDevelopmentWorldValue,
  deserializeDevelopmentWorldError,
  encodeDevelopmentWorldValue,
} from "#internal/workflow/development-world-codec.js";
import {
  getDevelopmentWorkflowGeneration,
  withDevelopmentWorkflowGeneration,
} from "#internal/workflow/development-generation-context.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  DEVELOPMENT_WORLD_OPERATIONS,
  type DevelopmentWorldCall,
  type DevelopmentWorldOperation,
} from "#internal/workflow/development-world-protocol.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

/**
 * Raised when a delivery's recorded generation no longer exists on disk.
 * This never heals on retry, so the queue handler acknowledges and drops
 * the delivery instead of letting the queue redeliver it for its full
 * retry budget.
 */
export class MissingDevelopmentGenerationError extends Error {
  constructor(generationId: string, cause?: unknown) {
    super(
      `Workflow run references missing development generation "${generationId}". ` +
        `Remove ".workflow-data" to discard the app's active local Workflow runs.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "MissingDevelopmentGenerationError";
  }
}

async function call<T>(
  operation: DevelopmentWorldOperation,
  args: readonly unknown[] = [],
): Promise<T> {
  const response = await fetchDevelopmentWorld(DEVELOPMENT_WORKFLOW_WORLD_ROUTE, {
    body: encodeDevelopmentWorldValue({
      arguments: args,
      operation,
    } satisfies DevelopmentWorldCall),
    method: "POST",
  });
  return decodeDevelopmentWorldValue(await response.text()) as T;
}

/**
 * Worker-side Workflow World: an interface-faithful shim whose every method
 * forwards to the real local World in the CLI parent process.
 *
 * Why: a dev worker is disposed on every structural reload, so nothing with
 * run lifetime may live inside it. The `World` interface is already fully
 * async because production Worlds are remote services — inserting HTTP
 * between the runtime and the World changes topology, not semantics, and
 * makes development match production's compute/state split. The runtime
 * cannot observe the difference, so `@workflow/core` needs no changes and
 * this file is deletable the day a multi-process local World ships upstream.
 *
 * Two members are not simple forwards. `streams.get` must return a live
 * `ReadableStream`, so it uses a dedicated route and hands back the response
 * body. `createQueueHandler` points the other way entirely: it returns the
 * HTTP handler that the parent's queue posts deliveries into, and is where a
 * delivery gets pinned to the generation its run started on.
 */
export function createDevelopmentWorkflowWorld(): World {
  const forwarded = buildForwardedOperations();
  const world = {
    specVersion: 5 as SpecVersion,
    processExitTriggersQueueRedelivery: false,
    async getDeploymentId() {
      // Inside a pinned delivery, steps and child runs must record the
      // delivery's generation — not whatever is active — so replay after a
      // reload returns to the same authored modules.
      return (
        getDevelopmentWorkflowGeneration()?.generationId ?? (await call<string>("getDeploymentId"))
      );
    },
    resolveLatestDeploymentId: forwarded.topLevel
      .resolveLatestDeploymentId as World["resolveLatestDeploymentId"],
    queue: forwarded.topLevel.queue as World["queue"],
    createQueueHandler,
    runs: forwarded.groups.runs as World["runs"],
    steps: forwarded.groups.steps as World["steps"],
    events: forwarded.groups.events as World["events"],
    hooks: forwarded.groups.hooks as World["hooks"],
    streams: {
      ...forwarded.groups.streams,
      // A live stream cannot ride the value codec; it flows through a
      // dedicated route as a raw response body.
      get: async (runId: string, name: string, startIndex?: number) => {
        const url = new URL(resolveDevelopmentWorldBaseUrl());
        url.pathname = DEVELOPMENT_WORKFLOW_STREAM_ROUTE;
        url.searchParams.set("runId", runId);
        url.searchParams.set("name", name);
        if (startIndex !== undefined) {
          url.searchParams.set("startIndex", String(startIndex));
        }
        const response = await fetchDevelopmentWorld(url, { method: "GET" });
        if (response.body === null) {
          throw new Error("Development Workflow stream response had no body.");
        }
        return response.body;
      },
    } as World["streams"],
    async start() {},
    async close() {},
  } satisfies World;

  return world;
}

type ForwardedOperation = (...args: unknown[]) => Promise<unknown>;

/**
 * Generates one forwarding method per entry in the shared operation table,
 * so the client's surface tracks the table instead of hand-written stubs.
 */
function buildForwardedOperations(): {
  readonly groups: Readonly<Record<string, Readonly<Record<string, ForwardedOperation>>>>;
  readonly topLevel: Readonly<Record<string, ForwardedOperation>>;
} {
  const groups: Record<string, Record<string, ForwardedOperation>> = {};
  const topLevel: Record<string, ForwardedOperation> = {};
  for (const operation of DEVELOPMENT_WORLD_OPERATIONS) {
    const forward: ForwardedOperation = async (...args) => await call(operation, args);
    const separator = operation.indexOf(".");
    if (separator === -1) {
      topLevel[operation] = forward;
    } else {
      (groups[operation.slice(0, separator)] ??= {})[operation.slice(separator + 1)] = forward;
    }
  }
  return { groups, topLevel };
}

function createQueueHandler(
  prefix: QueuePrefix,
  handler: (
    message: unknown,
    metadata: {
      attempt: number;
      queueName: ValidQueueName;
      messageId: MessageId;
      requestId?: string;
    },
  ) => Promise<void | { timeoutSeconds: number }>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const secret = readRequiredEnvironment(DEVELOPMENT_WORKFLOW_SECRET_ENV);
    const deliveryHeader = request.headers.get(DEVELOPMENT_WORKFLOW_DELIVERY_HEADER);
    if (deliveryHeader === null || !timingSafeEqualStrings(deliveryHeader, secret)) {
      return Response.json({ error: "Workflow delivery is not trusted." }, { status: 401 });
    }
    const queueName = request.headers.get("x-vqs-queue-name");
    const messageId = request.headers.get("x-vqs-message-id");
    const attempt = Number(request.headers.get("x-vqs-message-attempt"));
    if (
      queueName === null ||
      !queueName.startsWith(prefix) ||
      messageId === null ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      request.body === null
    ) {
      return Response.json({ error: "Workflow delivery is malformed." }, { status: 400 });
    }
    const message = decodeDevelopmentWorldJson(await request.text());
    try {
      const appRoot = readRequiredEnvironment(DEVELOPMENT_WORKER_APP_ROOT_ENV);
      const generationId = await resolveDeliveryGenerationId(message);
      const runtimeAppRoot = await readGenerationRuntimeAppRoot(appRoot, generationId);
      const result = await withDevelopmentWorkflowGeneration(
        {
          generationId,
          source: createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot, {
            durableReference: "development-generation",
            moduleMapLoaderPath: resolvePackageSourceFilePath(
              "src/internal/authored-module-map-loader.ts",
            ),
            sandboxAppRoot: appRoot,
          }),
        },
        async () =>
          await handler(message, {
            attempt,
            messageId: messageId as MessageId,
            queueName: queueName as ValidQueueName,
          }),
      );
      return Response.json(
        result === undefined ? { ok: true } : { timeoutSeconds: result.timeoutSeconds },
      );
    } catch (error) {
      if (error instanceof MissingDevelopmentGenerationError) {
        // Retrying cannot bring the generation back; acknowledge the
        // delivery so the queue stops redelivering, and leave the loud
        // error for the user to act on.
        console.error(`[eve:dev] ${error.message}`);
        return Response.json({ ok: true });
      }
      return Response.json(String(error), { status: 500 });
    }
  };
}

/**
 * Resolves the generation a delivery executes against. Selection trusts two
 * sources: run records owned by the parent World, and — for the first
 * delivery of a resilient start, which can arrive before its run record is
 * persisted — the `runInput.deploymentId` carried in the delivery body
 * itself. The body is trustworthy because deliveries are produced only by
 * the parent's queue and authenticated with the transport secret; nothing
 * an untrusted caller controls participates.
 */
async function resolveDeliveryGenerationId(message: unknown): Promise<string> {
  if (!isRecord(message)) {
    return await call<string>("resolveLatestDeploymentId");
  }
  const runInput = isRecord(message.runInput) ? message.runInput : undefined;
  if (runInput !== undefined) {
    return runInput.workflowName === turnWorkflowReference.workflowId &&
      typeof runInput.deploymentId === "string"
      ? runInput.deploymentId
      : await call<string>("resolveLatestDeploymentId");
  }
  const runId =
    typeof message.runId === "string"
      ? message.runId
      : typeof message.workflowRunId === "string"
        ? message.workflowRunId
        : undefined;
  if (runId === undefined) {
    return await call<string>("resolveLatestDeploymentId");
  }
  const run = await call<{ readonly deploymentId: string; readonly workflowName: string }>(
    "runs.get",
    [runId, { resolveData: "none" }],
  );
  return run.workflowName === turnWorkflowReference.workflowId
    ? run.deploymentId
    : await call<string>("resolveLatestDeploymentId");
}

async function readGenerationRuntimeAppRoot(
  appRoot: string,
  generationId: string,
): Promise<string> {
  if (
    generationId.length === 0 ||
    generationId === "." ||
    generationId === ".." ||
    basename(generationId) !== generationId
  ) {
    throw new Error(`Workflow run references invalid development generation "${generationId}".`);
  }
  const metadataPath = join(
    appRoot,
    ".eve",
    "dev-runtime",
    "snapshots",
    generationId,
    "generation.json",
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new MissingDevelopmentGenerationError(generationId, error);
  }
  if (!isRecord(metadata) || typeof metadata.runtimeAppRoot !== "string") {
    throw new Error(`Development generation "${generationId}" has invalid metadata.`);
  }
  return metadata.runtimeAppRoot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchDevelopmentWorld(route: string | URL, init: RequestInit): Promise<Response> {
  const url = route instanceof URL ? route : new URL(route, resolveDevelopmentWorldBaseUrl());
  const headers = new Headers(init.headers);
  headers.set(
    DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
    readRequiredEnvironment(DEVELOPMENT_WORKFLOW_SECRET_ENV),
  );
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const source = await response.text();
    const error = readDevelopmentWorldError(source);
    if (error !== undefined) {
      throw error;
    }
    throw new Error(
      `Development Workflow World request failed (${String(response.status)}): ${source}`,
    );
  }
  return response;
}

function readDevelopmentWorldError(source: string): Error | undefined {
  try {
    return deserializeDevelopmentWorldError(decodeDevelopmentWorldValue(source));
  } catch {
    return undefined;
  }
}

function resolveDevelopmentWorldBaseUrl(): string {
  return readRequiredEnvironment(WORKFLOW_LOCAL_BASE_URL_ENV);
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Development Workflow transport is missing ${name}.`);
  }
  return value;
}
