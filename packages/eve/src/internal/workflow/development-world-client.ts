import type {
  MessageId,
  QueuePrefix,
  SpecVersion,
  ValidQueueName,
  World,
} from "#compiled/@workflow/world/index.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";

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
import { cancelExpiredDevelopmentRun } from "#internal/workflow/cancel-expired-development-run.js";
import { isMissingWorkflowRunError } from "#internal/workflow/is-inactive-workflow-run-error.js";
import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  DEVELOPMENT_WORLD_OPERATIONS,
  type DevelopmentGenerationAdmission,
  type DevelopmentGenerationAvailabilityCall,
  type DevelopmentWorldCall,
  type DevelopmentWorldOperation,
} from "#internal/workflow/development-world-protocol.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

export class MissingDevelopmentGenerationError extends Error {
  constructor(generationId: string, cause?: unknown) {
    super(
      `Workflow run references missing development generation "${generationId}". Start a new local session.`,
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

async function getGenerationAvailability(
  generationId: string,
): Promise<DevelopmentGenerationAdmission> {
  const response = await fetchDevelopmentWorld(DEVELOPMENT_WORKFLOW_WORLD_ROUTE, {
    body: encodeDevelopmentWorldValue({
      operation: "eve.getGenerationAvailability",
      generationId,
    } satisfies DevelopmentGenerationAvailabilityCall),
    method: "POST",
  });
  return decodeDevelopmentWorldValue(await response.text()) as DevelopmentGenerationAdmission;
}

export function createDevelopmentWorkflowWorld(): World {
  const forwarded = buildForwardedOperations();
  const world = {
    specVersion: EVE_WORKFLOW_SPEC_VERSION as SpecVersion,
    capabilities: {
      atomicStartHook: { active: true },
      hookForceClaim: true,
      hookRetention: { active: true },
      inBandFence: true,
    },
    async getDeploymentId() {
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
    events: forwarded.groups.events as Omit<World["events"], "subscribe">,
    hooks: forwarded.groups.hooks as World["hooks"],
    streams: {
      ...forwarded.groups.streams,
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
      if (generationId === undefined) return Response.json({ ok: true });
      const availability = await getGenerationAvailability(generationId);
      if (availability.kind === "missing")
        throw new MissingDevelopmentGenerationError(generationId);
      if (availability.kind === "ineligible" || availability.kind === "dormant")
        return Response.json({ ok: true });
      const runtimeAppRoot = availability.runtimeAppRoot;
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
        const runId = resolveDeliveryRunId(message);
        if (runId !== undefined) {
          try {
            await cancelExpiredDevelopmentRun(createDevelopmentWorkflowWorld(), runId);
          } catch (cleanupError) {
            return Response.json(String(cleanupError), { status: 500 });
          }
        }
        return Response.json({ ok: true });
      }
      return Response.json(String(error), { status: 500 });
    }
  };
}

async function resolveDeliveryGenerationId(message: unknown): Promise<string | undefined> {
  if (!isRecord(message) || message.__healthCheck === true) {
    return await call<string>("resolveLatestDeploymentId");
  }
  const runInput = isRecord(message.runInput) ? message.runInput : undefined;
  if (runInput !== undefined) {
    return typeof runInput.deploymentId === "string"
      ? runInput.deploymentId
      : await call<string>("resolveLatestDeploymentId");
  }
  const runId = resolveDeliveryRunId(message);
  if (runId === undefined) {
    return await call<string>("resolveLatestDeploymentId");
  }
  try {
    const run = await call<{ readonly deploymentId: string }>("runs.get", [
      runId,
      { resolveData: "none" },
    ]);
    return run.deploymentId;
  } catch (error) {
    if (!isMissingWorkflowRunError(error)) throw error;
    return undefined;
  }
}

function resolveDeliveryRunId(message: unknown): string | undefined {
  if (!isRecord(message) || message.__healthCheck === true) return undefined;
  return typeof message.runId === "string"
    ? message.runId
    : typeof message.workflowRunId === "string"
      ? message.workflowRunId
      : undefined;
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
