import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { ValidQueueName, World } from "#compiled/@workflow/world/index.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { turnWorkflowReference } from "#execution/workflow-runtime.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
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
  type DevelopmentWorldCall,
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
    this.#world = createWorld({
      dataDir: join(input.appRoot, ".workflow-data"),
      recoverActiveRuns: false,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const referencedGenerationIds = await this.#collectActiveTurnGenerationIds();
    const missingGenerationIds = new Set<string>();
    for (const generationId of referencedGenerationIds) {
      if (!this.#generationExists(generationId)) {
        missingGenerationIds.add(generationId);
      }
    }
    if (missingGenerationIds.size > 0) {
      // One poisoned run must not take the rest of the app's active runs
      // down with it: quarantine its deliveries and keep booting.
      console.error(
        `[eve:dev] ${String(missingGenerationIds.size)} active local Workflow run(s) reference development generations that no longer exist ` +
          `(${[...missingGenerationIds].join(", ")}). Their deliveries are quarantined; ` +
          `remove ".workflow-data" to discard the app's active local Workflow runs.`,
      );
    }
    await this.#world.start?.();
    this.#started = true;
    await reenqueueActiveDevelopmentRuns({
      enqueue: this.#queue.bind(this),
      prefix: deriveEveWorkflowQueuePrefix(this.#agentName),
      quarantinedGenerationIds: missingGenerationIds,
      world: this.#world,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#started = false;
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

  async #collectActiveTurnGenerationIds(): Promise<ReadonlySet<string>> {
    const generationIds = new Set<string>();
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
              `Remove ".workflow-data" to discard them.`,
            { cause: error },
          );
        }
        for (const run of page.data) {
          if (run.workflowName === turnWorkflowReference.workflowId) {
            generationIds.add(run.deploymentId);
          }
        }
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
    }
    return generationIds;
  }

  async #handleCall(request: Request): Promise<Response> {
    if (!this.#isTrusted(request) || request.method !== "POST") {
      return Response.json({ error: "Workflow World request is not trusted." }, { status: 401 });
    }
    try {
      const call = decodeDevelopmentWorldValue(await request.text()) as DevelopmentWorldCall;
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

  async #call(call: DevelopmentWorldCall): Promise<unknown> {
    if (!isDevelopmentWorldCall(call)) {
      throw new Error("Development Workflow World call is malformed.");
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

  #generationExists(generationId: string): boolean {
    if (!isValidGenerationId(generationId)) {
      return false;
    }
    return existsSync(
      join(this.#appRoot, ".eve", "dev-runtime", "snapshots", generationId, "generation.json"),
    );
  }
}

function isValidGenerationId(generationId: string): boolean {
  return (
    generationId.length > 0 &&
    generationId !== "." &&
    generationId !== ".." &&
    basename(generationId) === generationId
  );
}

const DEVELOPMENT_WORLD_OPERATION_SET: ReadonlySet<string> = new Set(DEVELOPMENT_WORLD_OPERATIONS);

function isDevelopmentWorldCall(value: unknown): value is DevelopmentWorldCall {
  return (
    isObject(value) &&
    typeof value.operation === "string" &&
    DEVELOPMENT_WORLD_OPERATION_SET.has(value.operation) &&
    Array.isArray(value.arguments)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function reenqueueActiveDevelopmentRuns(input: {
  readonly enqueue: World["queue"];
  readonly prefix: string;
  readonly quarantinedGenerationIds: ReadonlySet<string>;
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
            `Remove ".workflow-data" to discard them.`,
          { cause: error },
        );
      }
      for (const run of page.data) {
        if (input.quarantinedGenerationIds.has(run.deploymentId)) {
          continue;
        }
        await input.enqueue(`${input.prefix}${run.workflowName}` as ValidQueueName, {
          runId: run.runId,
        });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
}
