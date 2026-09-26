import { readDevelopmentGenerationAvailability } from "#internal/workflow/development-runtime-compatibility.js";

import { cancelExpiredDevelopmentRun } from "#internal/workflow/cancel-expired-development-run.js";
import type { ValidQueueName, World } from "#compiled/@workflow/world/index.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import {
  LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH,
  resolveLocalWorkflowWorldDataDirectory,
} from "#internal/workflow/local-world-data-directory.js";
import { applyLocalWorkflowWorldDeliveryTimeoutDefaults } from "#internal/workflow/local-world-delivery-timeouts.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  DEVELOPMENT_WORLD_OPERATIONS,
  type DevelopmentWorldRequest,
} from "#internal/workflow/development-world-protocol.js";

/**
 * The application's one local Workflow World, owned by the CLI parent.
 *
 * Why the parent: run records, the queue, and stream state must outlive the
 * Nitro dev worker, which is disposed on every structural reload. The parent
 * is the only process whose lifetime matches the run data, so it holds the
 * real (stock, vendored) world-local instance and serves it to workers over
 * an RPC route on the public listener; workers hold only an
 * interface-faithful client. Deliveries are not served here — the queue
 * posts them through the public listener to the active worker like any
 * other request, so drained replacement covers them automatically.
 *
 * `handleRequest` must be reachable before `start()` runs: starting the
 * world begins queue redelivery immediately, and a delivery's first World
 * call arrives back on the listener within milliseconds.
 */
export interface ParentDevelopmentWorkflowWorld {
  close(): Promise<void>;
  handleRequest(request: Request): Promise<Response | undefined>;
  start(): Promise<void>;
  reconcileExpiredRuns(): Promise<void>;
}

export function createParentDevelopmentWorkflowWorld(input: {
  readonly agentName: string;
  readonly appRoot: string;
  readonly resolveActiveGenerationId: () => string;
  readonly transportSecret: string;
}): ParentDevelopmentWorkflowWorld {
  return new LocalParentDevelopmentWorkflowWorld(input);
}

class LocalParentDevelopmentWorkflowWorld implements ParentDevelopmentWorkflowWorld {
  readonly #agentName: string;
  readonly #appRoot: string;
  readonly #resolveActiveGenerationId: () => string;
  readonly #transportSecret: string;
  readonly #world: World;
  #closed = false;
  #started = false;
  #reconciliation: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly agentName: string;
    readonly appRoot: string;
    readonly resolveActiveGenerationId: () => string;
    readonly transportSecret: string;
  }) {
    if (input.transportSecret.length < 16) {
      throw new Error("Development Workflow transport secret is too short to be trusted.");
    }
    this.#agentName = input.agentName;
    this.#appRoot = input.appRoot;
    this.#resolveActiveGenerationId = input.resolveActiveGenerationId;
    this.#transportSecret = input.transportSecret;
    applyLocalWorkflowWorldDeliveryTimeoutDefaults();
    this.#world = createWorld({
      dataDir: resolveLocalWorkflowWorldDataDirectory(input.appRoot),
      recoverActiveRuns: false,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await this.#world.start?.();
    this.#started = true;
    try {
      await this.#reconcileExpiredRuns();
      const skippedGenerations = new Set<string>();
      await reenqueueActiveDevelopmentRuns({
        enqueue: this.#queue.bind(this),
        prefix: deriveEveWorkflowQueuePrefix(this.#agentName),
        world: this.#world,
        canRecover: async (generationId) => {
          const availability = await this.#generationAvailability(generationId);
          if (availability.kind === "incompatible" && !skippedGenerations.has(generationId)) {
            skippedGenerations.add(generationId);
            console.warn(
              `[eve:dev] Skipping retained Workflow generation "${generationId}": ${availability.reason}`,
            );
          }
          return availability.kind === "ready";
        },
      });
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#started = false;
    // Reconciliation failures belong to their caller, not a later shutdown.
    await this.#reconciliation.catch(() => undefined);
    await this.#world.close?.();
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === DEVELOPMENT_WORKFLOW_WORLD_ROUTE) {
      return await this.#handleCall(request);
    }
    if (url.pathname === DEVELOPMENT_WORKFLOW_STREAM_ROUTE) {
      return await this.#handleStream(request, url);
    }
    return undefined;
  }

  async reconcileExpiredRuns(): Promise<void> {
    if (!this.#started || this.#closed) return;
    await this.#reconcileExpiredRuns();
  }

  #reconcileExpiredRuns(): Promise<void> {
    this.#reconciliation = this.#reconciliation
      .catch(() => undefined)
      .then(async () => {
        if (this.#closed) return;
        const runIds = await this.#collectExpiredRunIds();
        for (const runId of runIds) {
          await cancelExpiredDevelopmentRun(this.#world, runId);
        }
      });
    return this.#reconciliation;
  }

  async #collectExpiredRunIds(): Promise<readonly string[]> {
    // Finish pagination before cancellation changes the status-filtered result set.
    const runIds: string[] = [];
    for (const status of ["pending", "running"] as const) {
      let cursor: string | undefined;
      do {
        let page: Awaited<ReturnType<World["runs"]["list"]>>;
        try {
          page = await this.#world.runs.list({
            pagination: { cursor, limit: 1_000 },
            resolveData: "none",
            status,
          });
        } catch (error) {
          throw new Error(
            `Failed to read the app's active local Workflow runs. ` +
              `Remove "${LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH}" to discard them.`,
            { cause: error },
          );
        }
        for (const run of page.data) {
          const availability = await this.#generationAvailability(run.deploymentId);
          if (availability.kind === "missing") runIds.push(run.runId);
        }
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
    }
    return runIds;
  }

  async #handleCall(request: Request): Promise<Response> {
    if (!this.#isTrusted(request) || request.method !== "POST") {
      return Response.json({ error: "Workflow World request is not trusted." }, { status: 401 });
    }
    try {
      const call = decodeDevelopmentWorldValue(await request.text());
      const result = await this.#call(call);
      return new Response(encodeDevelopmentWorldValue(result));
    } catch (error) {
      return new Response(encodeDevelopmentWorldValue(serializeDevelopmentWorldError(error)), {
        status: 500,
      });
    }
  }

  async #handleStream(request: Request, url: URL): Promise<Response> {
    if (!this.#isTrusted(request) || request.method !== "GET") {
      return Response.json({ error: "Workflow World request is not trusted." }, { status: 401 });
    }
    const runId = url.searchParams.get("runId");
    const name = url.searchParams.get("name");
    const rawStartIndex = url.searchParams.get("startIndex");
    if (runId === null || name === null) {
      return Response.json({ error: "Workflow stream request is malformed." }, { status: 400 });
    }
    const startIndex =
      rawStartIndex === null || rawStartIndex === "" ? undefined : Number(rawStartIndex);
    if (rawStartIndex === "" || (startIndex !== undefined && !Number.isInteger(startIndex))) {
      return Response.json({ error: "Workflow stream start index is invalid." }, { status: 400 });
    }
    try {
      return new Response(await this.#world.streams.get(runId, name, startIndex));
    } catch (error) {
      return new Response(encodeDevelopmentWorldValue(serializeDevelopmentWorldError(error)), {
        status: 500,
      });
    }
  }

  async #queue(...args: Parameters<World["queue"]>): ReturnType<World["queue"]> {
    const [queueName, message, options] = args;
    return await this.#world.queue(queueName, message, {
      ...options,
      headers: {
        ...options?.headers,
        [DEVELOPMENT_WORKFLOW_DELIVERY_HEADER]: this.#transportSecret,
      },
    });
  }

  async #call(call: unknown): Promise<unknown> {
    if (!isDevelopmentWorldRequest(call)) {
      throw new Error("Development Workflow World call is malformed.");
    }
    if (call.operation === "eve.getGenerationAvailability") {
      return await this.#generationAvailability(call.generationId);
    }
    const args = [...call.arguments];
    // Deployment identity and enqueueing carry eve semantics (generation
    // resolution, the delivery header); everything else forwards to the
    // vendored world by the dot-path the shared operation table names.
    if (call.operation === "getDeploymentId" || call.operation === "resolveLatestDeploymentId") {
      return this.#resolveActiveGenerationId();
    }
    if (call.operation === "queue") {
      return await this.#queue(...(args as Parameters<World["queue"]>));
    }
    if (call.operation === "streams.writeMulti" && this.#world.streams.writeMulti === undefined) {
      for (const chunk of args[2] as readonly (string | Uint8Array)[]) {
        await this.#world.streams.write(args[0] as string, args[1] as string, chunk);
      }
      return undefined;
    }
    const separator = call.operation.indexOf(".");
    const receiver: unknown = this.#world[call.operation.slice(0, separator) as keyof World];
    const operation =
      typeof receiver === "object" && receiver !== null
        ? (receiver as Record<string, unknown>)[call.operation.slice(separator + 1)]
        : undefined;
    if (typeof operation !== "function") {
      // Optional interface members (e.g. runs.experimentalSetAttributes)
      // no-op rather than fail a caller probing for support.
      return undefined;
    }
    return await Reflect.apply(operation, receiver, args);
  }

  #isTrusted(request: Request): boolean {
    const header = request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER);
    return header !== null && timingSafeEqualStrings(header, this.#transportSecret);
  }

  #generationAvailability(generationId: string) {
    return readDevelopmentGenerationAvailability(
      this.#appRoot,
      generationId,
      this.#resolveActiveGenerationId(),
    );
  }
}

const DEVELOPMENT_WORLD_OPERATION_SET: ReadonlySet<string> = new Set(DEVELOPMENT_WORLD_OPERATIONS);

function isDevelopmentWorldRequest(value: unknown): value is DevelopmentWorldRequest {
  return (
    isObject(value) &&
    typeof value.operation === "string" &&
    (value.operation === "eve.getGenerationAvailability"
      ? typeof value.generationId === "string"
      : DEVELOPMENT_WORLD_OPERATION_SET.has(value.operation) && Array.isArray(value.arguments))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function reenqueueActiveDevelopmentRuns(input: {
  readonly enqueue: World["queue"];
  readonly canRecover: (generationId: string) => Promise<boolean>;
  readonly prefix: string;
  readonly world: World;
}): Promise<void> {
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      let page: Awaited<ReturnType<World["runs"]["list"]>>;
      try {
        page = await input.world.runs.list({
          pagination: { cursor },
          resolveData: "none",
          status,
        });
      } catch (error) {
        throw new Error(
          `Failed to read the app's active local Workflow runs. ` +
            `Remove "${LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH}" to discard them.`,
          { cause: error },
        );
      }
      for (const run of page.data) {
        if (!(await input.canRecover(run.deploymentId))) continue;
        await input.enqueue(`${input.prefix}${run.workflowName}` as ValidQueueName, {
          runId: run.runId,
        });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
}
