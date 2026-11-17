import {
  readDevelopmentGenerationAvailability,
  type DevelopmentGenerationAvailability,
} from "#internal/workflow/development-runtime-compatibility.js";
import { listDevelopmentGenerationIds } from "#internal/nitro/dev-runtime-generation-metadata.js";

import { cancelExpiredDevelopmentRun } from "#internal/workflow/cancel-expired-development-run.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";
import type { ValidQueueName, World } from "#compiled/@workflow/world/index.js";
import { createWorld, type LocalWorld } from "#compiled/@workflow/world-local/index.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import {
  displayLocalWorkflowWorldDataDirectory,
  resolveLocalWorkflowWorldDataDirectory,
} from "#internal/workflow/local-world-data-directory.js";
import { applyLocalWorkflowWorldDeliveryTimeoutDefaults } from "#internal/workflow/local-world-delivery-timeouts.js";
import {
  localRecoveryMessage,
  releaseOrphanedLocalSteps,
} from "#internal/workflow/local-world-recovery.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#protocol/routes.js";
import { DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER } from "#internal/application/dev-transport.js";
import {
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORLD_OPERATIONS,
  type DevelopmentGenerationAdmission,
  type DevelopmentWorldRequest,
} from "#internal/workflow/development-world-protocol.js";

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
  readonly resume?: boolean;
  readonly transportSecret: string;
}): ParentDevelopmentWorkflowWorld {
  return new LocalParentDevelopmentWorkflowWorld(input);
}

class LocalParentDevelopmentWorkflowWorld implements ParentDevelopmentWorkflowWorld {
  readonly #agentName: string;
  readonly #appRoot: string;
  readonly #resolveActiveGenerationId: () => string;
  readonly #transportSecret: string;
  readonly #world: LocalWorld;
  readonly #resume: boolean;
  readonly #unrecoveredGenerations = new Map<
    string,
    | Extract<DevelopmentGenerationAvailability, { kind: "ineligible" }>
    | { readonly kind: "dormant" }
  >();
  #closed = false;
  #started = false;
  #reconciliation: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly agentName: string;
    readonly appRoot: string;
    readonly resolveActiveGenerationId: () => string;
    readonly resume?: boolean;
    readonly transportSecret: string;
  }) {
    if (input.transportSecret.length < 16) {
      throw new Error("Development Workflow transport secret is too short to be trusted.");
    }
    this.#resume = input.resume === true;
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
    const recoveryGenerationId = this.#resolveActiveGenerationId();
    this.#unrecoveredGenerations.clear();
    for (const generationId of await listDevelopmentGenerationIds(this.#appRoot)) {
      if (generationId === recoveryGenerationId) continue;
      if (!this.#resume) {
        this.#unrecoveredGenerations.set(generationId, { kind: "dormant" });
        continue;
      }
      const availability = await readDevelopmentGenerationAvailability(this.#appRoot, generationId);
      if (availability.kind === "ineligible") {
        this.#unrecoveredGenerations.set(generationId, availability);
      }
    }
    await this.#world.start?.();
    this.#started = true;
    try {
      await this.#reconcileExpiredRuns();
      if (!this.#resume) return;
      const skippedGenerations = new Set<string>();
      await reenqueueActiveDevelopmentRuns({
        appRoot: this.#appRoot,
        enqueue: this.#queue.bind(this),
        prefix: deriveEveWorkflowQueuePrefix(this.#agentName),
        world: this.#world,
        canRecover: async (generationId) => {
          const availability = await this.#generationAvailability(generationId);
          if (availability.kind === "ineligible" && !skippedGenerations.has(generationId)) {
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
              `Remove "${displayLocalWorkflowWorldDataDirectory(this.#appRoot)}" to discard them.`,
            { cause: error },
          );
        }
        for (const run of page.data) {
          const availability = await readDevelopmentGenerationAvailability(
            this.#appRoot,
            run.deploymentId,
          );
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
    if (call.operation === "getDeploymentId" || call.operation === "resolveLatestDeploymentId") {
      return this.#resolveActiveGenerationId();
    }
    if (call.operation === "queue") {
      return await this.#queue(...(args as Parameters<World["queue"]>));
    }
    if (call.operation === "hooks.getByToken" || call.operation === "hooks.get") {
      if (!this.#started) throw new Error("Local Workflow World is still starting.");
      const hook =
        call.operation === "hooks.getByToken"
          ? await this.#world.hooks.getByToken(
              ...(args as Parameters<World["hooks"]["getByToken"]>),
            )
          : await this.#world.hooks.get(...(args as Parameters<World["hooks"]["get"]>));
      const run = await this.#world.runs.get(hook.runId, { resolveData: "none" });
      const availability = await this.#generationAvailability(run.deploymentId);
      if (availability.kind === "dormant" || availability.kind === "ineligible") {
        throw new DevelopmentRunUnavailableError({
          availability: availability.kind,
          runId: hook.runId,
        });
      }
      return hook;
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
      return undefined;
    }
    return await Reflect.apply(operation, receiver, args);
  }

  #isTrusted(request: Request): boolean {
    const header = request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER);
    return header !== null && timingSafeEqualStrings(header, this.#transportSecret);
  }

  async #generationAvailability(generationId: string): Promise<DevelopmentGenerationAdmission> {
    const availability = await readDevelopmentGenerationAvailability(this.#appRoot, generationId);
    if (availability.kind !== "ready") return availability;
    return this.#unrecoveredGenerations.get(generationId) ?? availability;
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
  readonly appRoot: string;
  readonly enqueue: World["queue"];
  readonly canRecover: (generationId: string) => Promise<boolean>;
  readonly prefix: string;
  readonly world: LocalWorld;
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
            `Remove "${displayLocalWorkflowWorldDataDirectory(input.appRoot)}" to discard them.`,
          { cause: error },
        );
      }
      const recoverable = [];
      for (const run of page.data) {
        if (await input.canRecover(run.deploymentId)) recoverable.push(run);
      }
      await releaseOrphanedLocalSteps(
        input.world,
        recoverable.map((run) => run.runId),
      );
      for (const run of recoverable) {
        await input.enqueue(
          `${input.prefix}${run.workflowName}` as ValidQueueName,
          localRecoveryMessage(run),
        );
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
}
