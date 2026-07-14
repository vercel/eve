import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
import {
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  type DevelopmentWorldCall,
} from "#internal/workflow/development-world-protocol.js";

/**
 * The set of development generations that active Workflow runs still own.
 * `protectAll` reports that ownership could not be determined (an unreadable
 * run record), in which case pruning must keep every generation.
 */
export interface DevelopmentWorkflowGenerationReferences {
  readonly generationIds: ReadonlySet<string>;
  readonly protectAll: boolean;
}

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
  collectGenerationReferences(): Promise<DevelopmentWorkflowGenerationReferences>;
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
  readonly #dataDir: string;
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
    this.#agentName = input.agentName;
    this.#appRoot = input.appRoot;
    this.#dataDir = join(input.appRoot, ".workflow-data");
    this.#resolveActiveGenerationId = input.resolveActiveGenerationId;
    this.#transportSecret = input.transportSecret;
    this.#world = createWorld({
      dataDir: this.#dataDir,
      recoverActiveRuns: false,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const references = await this.collectGenerationReferences();
    if (!references.protectAll) {
      for (const generationId of references.generationIds) {
        this.#assertGenerationExists(generationId);
      }
    }
    await this.#world.start?.();
    this.#started = true;
    await reenqueueActiveDevelopmentRuns(
      this.#world,
      this.#queue.bind(this),
      deriveEveWorkflowQueuePrefix(this.#agentName),
    );
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

  async collectGenerationReferences(): Promise<DevelopmentWorkflowGenerationReferences> {
    const generationIds = new Set<string>();
    try {
      const runIds = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.#world.runs.list({
          pagination: { cursor, limit: 1_000 },
          resolveData: "none",
        });
        for (const run of page.data) {
          runIds.add(run.runId);
          if (
            (run.status === "pending" || run.status === "running") &&
            run.workflowName === turnWorkflowReference.workflowId
          ) {
            generationIds.add(run.deploymentId);
          }
        }
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      for (const persistedRunId of await this.#readPersistedRunIds()) {
        if (!runIds.has(persistedRunId)) {
          return { generationIds: new Set(), protectAll: true };
        }
      }
      return { generationIds, protectAll: false };
    } catch {
      return { generationIds: new Set(), protectAll: true };
    }
  }

  async #readPersistedRunIds(): Promise<readonly string[]> {
    try {
      const entries = await readdir(join(this.#dataDir, "runs"), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
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
    const startIndex = rawStartIndex === null ? undefined : Number(rawStartIndex);
    if (startIndex !== undefined && !Number.isInteger(startIndex)) {
      return Response.json({ error: "Workflow stream start index is invalid." }, { status: 400 });
    }
    return new Response(await this.#world.streams.get(runId, name, startIndex));
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
    switch (call.operation) {
      case "getDeploymentId":
      case "resolveLatestDeploymentId":
        return this.#resolveActiveGenerationId();
      case "queue":
        return await this.#queue(...(args as Parameters<World["queue"]>));
      case "runs.get":
        return await invoke(this.#world.runs.get, args, this.#world.runs);
      case "runs.list":
        return await invoke(this.#world.runs.list, args, this.#world.runs);
      case "runs.experimentalSetAttributes": {
        const operation = this.#world.runs.experimentalSetAttributes;
        if (operation === undefined) {
          return undefined;
        }
        return await invoke(operation, args, this.#world.runs);
      }
      case "steps.get":
        return await invoke(this.#world.steps.get, args, this.#world.steps);
      case "steps.list":
        return await invoke(this.#world.steps.list, args, this.#world.steps);
      case "events.create":
        return await invoke(this.#world.events.create, args, this.#world.events);
      case "events.get":
        return await invoke(this.#world.events.get, args, this.#world.events);
      case "events.list":
        return await invoke(this.#world.events.list, args, this.#world.events);
      case "events.listByCorrelationId":
        return await invoke(this.#world.events.listByCorrelationId, args, this.#world.events);
      case "hooks.get":
        return await invoke(this.#world.hooks.get, args, this.#world.hooks);
      case "hooks.getByToken":
        return await invoke(this.#world.hooks.getByToken, args, this.#world.hooks);
      case "hooks.list":
        return await invoke(this.#world.hooks.list, args, this.#world.hooks);
      case "streams.write":
        return await invoke(this.#world.streams.write, args, this.#world.streams);
      case "streams.writeMulti": {
        const operation = this.#world.streams.writeMulti;
        if (operation === undefined) {
          for (const chunk of args[2] as readonly (string | Uint8Array)[]) {
            await this.#world.streams.write(args[0] as string, args[1] as string, chunk);
          }
          return undefined;
        }
        return await invoke(operation, args, this.#world.streams);
      }
      case "streams.close":
        return await invoke(this.#world.streams.close, args, this.#world.streams);
      case "streams.list":
        return await invoke(this.#world.streams.list, args, this.#world.streams);
      case "streams.getChunks":
        return await invoke(this.#world.streams.getChunks, args, this.#world.streams);
      case "streams.getInfo":
        return await invoke(this.#world.streams.getInfo, args, this.#world.streams);
    }
  }

  #isTrusted(request: Request): boolean {
    return request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER) === this.#transportSecret;
  }

  #assertGenerationExists(generationId: string): void {
    if (basename(generationId) !== generationId) {
      throw new Error(`Workflow run references invalid development generation "${generationId}".`);
    }
    const manifestPath = join(
      this.#appRoot,
      ".eve",
      "dev-runtime",
      "snapshots",
      generationId,
      "generation.json",
    );
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Workflow run references missing development generation "${generationId}". ` +
          `Remove ".workflow-data" to discard the app's active local Workflow runs.`,
      );
    }
  }
}

function invoke(
  operation: (...args: never[]) => unknown,
  args: readonly unknown[],
  receiver: unknown,
): Promise<unknown> | unknown {
  return Reflect.apply(operation, receiver, args);
}

function isDevelopmentWorldCall(value: unknown): value is DevelopmentWorldCall {
  return isObject(value) && typeof value.operation === "string" && Array.isArray(value.arguments);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function reenqueueActiveDevelopmentRuns(
  world: World,
  enqueue: World["queue"],
  prefix: string,
): Promise<void> {
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        pagination: { cursor },
        resolveData: "none",
        status,
      });
      for (const run of page.data) {
        await enqueue(`${prefix}${run.workflowName}` as ValidQueueName, { runId: run.runId });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
}
