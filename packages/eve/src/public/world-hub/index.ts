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
  const deploymentId = options.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID ?? localId;
  const deploymentUrl =
    options.deploymentUrl ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  async function request(path: string, method: string, body = "") {
    const response = await fetch(new URL(path, options.url), {
      method,
      body: method === "GET" ? undefined : body,
      headers: {
        ...signWorldHubRequest(options.secret, method, path, body),
        "x-world-hub-deployment-id": deploymentId,
        "x-world-hub-deployment-url": deploymentUrl,
      },
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
  type BufferState = {
    runId: string;
    name: string;
    chunks: (string | Uint8Array)[];
    pending: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    error?: unknown;
  };
  const buffers = new Map<string, BufferState>();
  function state(runId: string, name: string) {
    const key = JSON.stringify([runId, name]);
    let value = buffers.get(key);
    if (!value) {
      value = { runId, name, chunks: [], pending: Promise.resolve() };
      buffers.set(key, value);
    }
    return value;
  }
  async function flush(value: BufferState) {
    clearTimeout(value.timer);
    value.timer = undefined;
    const chunks = value.chunks.splice(0);
    if (chunks.length)
      value.pending = value.pending
        .then(async () => {
          if (value.error) throw value.error;
          if (info.operations.includes("streams.writeMulti"))
            await call("streams.writeMulti", [value.runId, value.name, chunks]);
          else
            for (const chunk of chunks)
              await call("streams.write", [value.runId, value.name, chunk]);
        })
        .catch((error) => {
          value.error = error;
        });
    await value.pending;
    if (value.error) throw value.error;
  }
  async function flushAll() {
    await Promise.all([...buffers.values()].map(flush));
  }
  const world = {
    ...forwarded,
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
        if (!value.timer)
          value.timer = setTimeout(() => {
            void flush(value).catch(() => {});
          }, options.streamFlushIntervalMs ?? 30);
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
        await call("streams.close", [runId, name]);
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
      await flushAll();
      process.removeListener("beforeExit", beforeExit);
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
