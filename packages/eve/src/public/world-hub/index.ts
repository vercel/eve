// World-hub client: forwards World calls to an external host over signed HTTP.
import { randomUUID } from "node:crypto";
import type { World, MessageId, ValidQueueName } from "#compiled/@workflow/world/index.js";
import { WORLD_OPERATIONS } from "#internal/workflow/world-protocol.js";
import {
  encodeDevelopmentWorldValue as encode,
  decodeDevelopmentWorldValue as decode,
  deserializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { signWorldHubRequest, verifyWorldHubRequest } from "./auth.js";

export interface WorldHubOptions {
  url: string;
  secret: string;
  deploymentId?: string;
  deploymentUrl?: string;
  bypassSecret?: string;
  streamFlushIntervalMs?: number;
}
export interface WorldHubStats {
  rpcCalls: number;
  operations: Record<string, number>;
  streamChunks: number;
  writeMultiCalls: number;
}
const stats: WorldHubStats = { rpcCalls: 0, operations: {}, streamChunks: 0, writeMultiCalls: 0 };
/** Process-wide cumulative counters. Take snapshots around a turn to calculate deltas. */
export function getWorldHubStats(): WorldHubStats {
  return { ...stats, operations: { ...stats.operations } };
}
function statsEnabled(): boolean {
  return process.env.WORLD_HUB_STATS === "1";
}
const localId = `dpl_local_${randomUUID()}`;
export async function createWorldHubWorld(options: WorldHubOptions): Promise<World> {
  if (!options.secret) throw new Error("World hub requires a secret");
  const deploymentId =
    options.deploymentId?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.WORLD_HUB_DEPLOYMENT_ID?.trim() ||
    localId;
  const deploymentUrl =
    options.deploymentUrl ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  async function request(path: string, method: string, body = "") {
    const response = await fetch(new URL(path, options.url), {
      method,
      body: method === "GET" ? undefined : body,
      headers: signWorldHubRequest(
        options.secret,
        method,
        path,
        body,
        undefined,
        new Headers({
          "x-world-hub-deployment-id": deploymentId,
          "x-world-hub-deployment-url": deploymentUrl,
        }),
      ),
    });
    if (!response.ok) {
      const text = await response.text();
      let error;
      try {
        error = deserializeDevelopmentWorldError(decode(text));
      } catch {}
      throw error ?? new Error(`World hub HTTP ${response.status}: ${text}`);
    }
    return response;
  }
  async function call(operation: string, args: unknown[]) {
    if (statsEnabled()) {
      stats.rpcCalls++;
      stats.operations[operation] = (stats.operations[operation] ?? 0) + 1;
      if (operation === "streams.writeMulti") stats.writeMultiCalls++;
    }
    return decode(
      await (await request("/world/v1/rpc", "POST", encode({ operation, arguments: args }))).text(),
    );
  }
  const info = (await call("world.info", [])) as {
    specVersion: number;
    capabilities?: World["capabilities"];
    operations: string[];
  };
  const forwarded: Record<string, unknown> = {};
  for (const operation of WORLD_OPERATIONS) {
    if (!info.operations.includes(operation)) continue;
    const parts = operation.split(".");
    let owner = forwarded;
    for (const part of parts.slice(0, -1)) owner = (owner[part] ??= {}) as Record<string, unknown>;
    owner[parts.at(-1)!] = (...args: unknown[]) => call(operation, args);
  }
  // The SDK's createBatch contract excludes hook events. Use an explicitly
  // advertised extension instead: per-item SINGLE-create params/results keep
  // snapshot guards, inline deltas, force-claim victim details, and errors intact.
  // No client retries: a lost response must recover through workflow replay.
  type HookCreate = {
    args: Parameters<World["events"]["create"]>;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  };
  const hookBatches = new Map<string, HookCreate[]>();
  if (info.operations.includes("events.createHookBatch")) {
    const events = forwarded.events as Record<string, unknown>;
    const singleCreate = events.create as (...args: unknown[]) => Promise<unknown>;
    events.create = (...args: Parameters<World["events"]["create"]>) => {
      const [runId, event] = args;
      if (event.eventType !== "hook_created" || !runId) return singleCreate(...args);
      return new Promise((resolve, reject) => {
        const queued = hookBatches.get(runId);
        const item = { args, resolve, reject };
        if (queued) {
          queued.push(item);
          return;
        }
        const batch = [item];
        hookBatches.set(runId, batch);
        // Hook metadata dehydration is asynchronous. Collect independent token
        // claims across this microtask wave without adding a timed flush delay.
        setImmediate(async () => {
          hookBatches.delete(runId);
          try {
            const response = (await call("events.createHookBatch", [
              runId,
              batch.map(({ args: [, event, params] }) => ({ event, params })),
            ])) as { results: ({ value: unknown } | { error: unknown })[] };
            if (!Array.isArray(response?.results) || response.results.length !== batch.length)
              throw new Error("Invalid world hook batch response");
            // Validate all envelopes before resolving any claim.
            const outcomes = response.results.map((result) => {
              if ("error" in result) {
                const error = deserializeDevelopmentWorldError(result.error);
                if (!error) throw new Error("Invalid world hook batch error");
                return { error };
              }
              if (!("value" in result)) throw new Error("Invalid world hook batch result");
              return { value: result.value };
            });
            outcomes.forEach((result, index) => {
              if ("error" in result) batch[index]!.reject(result.error);
              else batch[index]!.resolve(result.value);
            });
          } catch (error) {
            for (const item of batch) item.reject(error);
          }
        });
      });
    };
  }
  type BufferState = {
    runId: string;
    name: string;
    chunks: (string | Uint8Array)[];
    pending?: Promise<void>;
    error?: unknown;
  };
  const buffers = new Map<string, BufferState>();
  function state(runId: string, name: string) {
    const key = JSON.stringify([runId, name]);
    let value = buffers.get(key);
    if (!value) {
      value = { runId, name, chunks: [] };
      buffers.set(key, value);
    }
    return value;
  }
  // One drain per stream. Start an idle stream immediately; only chunks that
  // arrive during its RPC coalesce, and the next batch follows without a timer.
  function drain(value: BufferState): Promise<void> {
    if (value.pending) return value.pending;
    value.pending = (async () => {
      while (value.chunks.length && !value.error) {
        const chunks = value.chunks.splice(0);
        if (info.operations.includes("streams.writeMulti"))
          await call("streams.writeMulti", [
            value.runId,
            value.name,
            chunks,
            { operationId: randomUUID() },
          ]);
        else
          for (const chunk of chunks)
            await call("streams.write", [
              value.runId,
              value.name,
              chunk,
              { operationId: randomUUID() },
            ]);
      }
    })()
      .catch((error) => {
        value.error = error;
      })
      .finally(() => {
        value.pending = undefined;
      });
    return value.pending;
  }
  async function flush(value: BufferState) {
    // A write can arrive as an existing drain's final promise settles. Recheck
    // after awaiting so read/close barriers do not strand accepted chunks.
    do {
      if (value.error) throw value.error;
      await drain(value);
      if (value.error) throw value.error;
    } while (value.chunks.length);
  }
  async function flushAll() {
    await Promise.all([...buffers.values()].map(flush));
  }
  const world = {
    ...forwarded,
    async getDeploymentId() {
      return deploymentId || (await call("getDeploymentId", []));
    },
    // SDK step scheduling may omit deploymentId; retain this client's deployment.
    queue: ((name, message, opts) =>
      call("queue", [
        name,
        message,
        { ...opts, deploymentId: opts?.deploymentId ?? deploymentId },
      ])) as World["queue"],
    specVersion: info.specVersion,
    capabilities: info.capabilities,
    streamFlushIntervalMs: options.streamFlushIntervalMs ?? 30,
    createQueueHandler: ((prefix, handler) => async (req: Request) => {
      const body = await req.text();
      const url = new URL(req.url);
      if (
        !verifyWorldHubRequest(
          options.secret,
          req.method,
          url.pathname + url.search,
          body,
          req.headers,
        )
      )
        return new Response("Unauthorized", { status: 401 });
      const queueName = req.headers.get("x-vqs-queue-name");
      const messageId = req.headers.get("x-vqs-message-id");
      const attempt = Number(req.headers.get("x-vqs-message-attempt"));
      if (!queueName?.startsWith(prefix) || !messageId || !Number.isInteger(attempt) || attempt < 1)
        return new Response("Malformed delivery", { status: 400 });
      try {
        const result = await handler(decode(body), {
          queueName: queueName as ValidQueueName,
          messageId: messageId as MessageId,
          attempt,
        });
        return Response.json(result ?? { ok: true });
      } catch (error) {
        console.error("World hub delivery failed", error);
        return new Response("Delivery failed", { status: 500 });
      }
    }) as World["createQueueHandler"],
    streams: {
      ...(forwarded.streams as World["streams"]),
      async write(runId: string, name: string, chunk: string | Uint8Array) {
        const value = state(runId, name);
        if (value.error) throw value.error;
        if (statsEnabled()) stats.streamChunks++;
        value.chunks.push(chunk);
        void drain(value).then(() => {
          // Cover a write accepted during the drain's promise-finalization gap.
          if (value.chunks.length && !value.error) void drain(value);
        });
      },
      async writeMulti(runId: string, name: string, chunks: (string | Uint8Array)[]) {
        const value = state(runId, name);
        if (value.error) throw value.error;
        if (statsEnabled()) stats.streamChunks += chunks.length;
        value.chunks.push(...chunks);
        await flush(value);
      },
      async close(runId: string, name: string) {
        await flush(state(runId, name));
        await call("streams.close", [runId, name, { operationId: randomUUID() }]);
      },
      async getChunks(runId: string, name: string, opts?: unknown) {
        await flush(state(runId, name));
        return call("streams.getChunks", [runId, name, opts]);
      },
      async get(runId: string, name: string, startIndex?: number) {
        await flush(state(runId, name));
        const query = new URLSearchParams({ runId, name });
        if (startIndex !== undefined) query.set("startIndex", String(startIndex));
        const response = await request(`/world/v1/streams?${query}`, "GET");
        if (!response.body) throw new Error("Missing stream body");
        return response.body;
      },
    },
    async start() {},
    async close() {
      try {
        await flushAll();
      } finally {
        process.removeListener("beforeExit", beforeExit);
      }
    },
  } as unknown as World;
  function beforeExit() {
    void flushAll()
      .then(() => {
        if (statsEnabled()) console.log("World hub stats", JSON.stringify(getWorldHubStats()));
      })
      .catch((error) => {
        console.error("World hub stream flush failed", error);
        process.exitCode = 1;
      });
  }
  process.on("beforeExit", beforeExit);
  return world;
}
export function createWorld(): Promise<World> {
  const url = process.env.WORLD_HUB_URL;
  const secret = process.env.WORLD_HUB_SECRET;
  if (!url || !secret) throw new Error("WORLD_HUB_URL and WORLD_HUB_SECRET are required");
  return createWorldHubWorld({
    url,
    secret,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.WORLD_HUB_DEPLOYMENT_ID,
    deploymentUrl: process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.WORLD_HUB_DEPLOYMENT_URL,
  });
}
export default createWorld;

/** Hub persistence and streams with Vercel Queues delivery and deployment identity. */
export async function createHubVercelWorld(options: WorldHubOptions): Promise<World> {
  const { createQueue } = await import("#compiled/@workflow/world-vercel/index.js");
  const queue = createQueue();
  return { ...(await createWorldHubWorld(options)), ...queue };
}
