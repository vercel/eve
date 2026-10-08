import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { World } from "#compiled/@workflow/world/index.js";
import { WORLD_OPERATIONS } from "#internal/workflow/world-protocol.js";
import {
  encodeDevelopmentWorldValue as encode,
  decodeDevelopmentWorldValue as decode,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { signWorldHubRequest, verifyWorldHubRequest } from "./auth.js";
export { signWorldHubRequest, verifyWorldHubRequest } from "./auth.js";

function member(
  world: World,
  operation: string,
): { owner: Record<string, unknown>; fn: (...args: unknown[]) => unknown } | undefined {
  const parts = operation.split(".");
  let owner = world as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = owner[part];
    if (!next || typeof next !== "object") return;
    owner = next as Record<string, unknown>;
  }
  const fn = owner[parts.at(-1)!];
  if (typeof fn === "function") return { owner, fn: fn as (...args: unknown[]) => unknown };
}
export interface WorldHubServerOptions {
  world: World;
  secret: string;
  onDeployment?: (id: string, url: string) => void | Promise<void>;
}
export function createWorldHubServer(
  options: WorldHubServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (!options.secret) throw new Error("World hub requires a secret");
  return async (req, res) => {
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const part = Buffer.from(chunk);
        size += part.length;
        if (size > 16 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        parts.push(part);
      }
      const body = Buffer.concat(parts);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      if (
        !verifyWorldHubRequest(options.secret, req.method ?? "GET", req.url ?? "/", body, headers)
      ) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://world-hub");
      const id = headers.get("x-world-hub-deployment-id");
      const deploymentUrl = headers.get("x-world-hub-deployment-url");
      if (id && deploymentUrl) await options.onDeployment?.(id, deploymentUrl);
      if (req.method === "GET" && url.pathname === "/world/v1/streams") {
        const runId = url.searchParams.get("runId");
        const name = url.searchParams.get("name");
        const index = url.searchParams.get("startIndex");
        if (!runId || !name || (index !== null && !Number.isInteger(Number(index)))) {
          res.writeHead(400).end();
          return;
        }
        const stream = await options.world.streams.get(
          runId,
          name,
          index === null ? undefined : Number(index),
        );
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        });
        res.flushHeaders();
        const source = Readable.fromWeb(stream);
        res.on("close", () => source.destroy());
        source.on("error", (error) => res.destroy(error));
        source.pipe(res);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/world/v1/rpc") {
        res.writeHead(404).end();
        return;
      }
      const call = decode(body.toString()) as { operation: string; arguments: unknown[] };
      if (!call || !Array.isArray(call.arguments)) {
        res.writeHead(400).end();
        return;
      }
      if (call.operation === "world.info") {
        res.setHeader("content-type", "application/json");
        res.end(
          encode({
            specVersion: options.world.specVersion,
            capabilities: options.world.capabilities,
            operations: WORLD_OPERATIONS.filter((op) => member(options.world, op)),
          }),
        );
        return;
      }
      if (!(WORLD_OPERATIONS as readonly string[]).includes(call.operation)) {
        res.writeHead(400).end();
        return;
      }
      if (
        id &&
        (call.operation === "getDeploymentId" || call.operation === "resolveLatestDeploymentId")
      ) {
        res.end(encode(id));
        return;
      }
      const target = member(options.world, call.operation);
      if (!target) {
        res.writeHead(501).end();
        return;
      }
      const result = await target.fn.apply(target.owner, call.arguments);
      res.setHeader("content-type", "application/json");
      res.end(encode(result));
    } catch (error) {
      if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
      else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(encode(serializeDevelopmentWorldError(error)));
      }
    }
  };
}
export interface WorldHubDispatcherOptions {
  secret: string;
  resolveDeploymentUrl: (deploymentId: string) => string | Promise<string>;
  bypassSecret?: string;
  path?: string;
  fetch?: typeof globalThis.fetch;
  onDeliveryError?: (error: unknown, messageId: string) => void;
}
export function createWorldHubDispatcher(options: WorldHubDispatcherOptions): World["queue"] {
  if (!options.secret) throw new Error("World hub requires a secret");
  return async (queueName, message, opts) => {
    if (!opts?.deploymentId) throw new Error("Dispatch requires deploymentId");
    const base = await options.resolveDeploymentUrl(opts.deploymentId);
    const url = new URL(options.path ?? "/eve/v1/workflow/dispatch", base);
    const path = url.pathname + url.search;
    const messageId = `msg_${randomUUID()}`;
    const body = encode(message);
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const deliver = async () => {
      if (opts.delaySeconds) await delay(opts.delaySeconds * 1000);
      for (let attempt = 1; attempt <= 10; attempt++) {
        let retrySeconds: number | undefined;
        try {
          const response = await (options.fetch ?? fetch)(url, {
            method: "POST",
            body,
            headers: {
              ...opts.headers,
              ...signWorldHubRequest(options.secret, "POST", path, body),
              "content-type": "application/json",
              "x-vqs-queue-name": queueName,
              "x-vqs-message-id": messageId,
              "x-vqs-message-attempt": String(attempt),
              ...(options.bypassSecret
                ? { "x-vercel-protection-bypass": options.bypassSecret }
                : {}),
            },
            signal: AbortSignal.timeout(300_000),
          });
          if (response.ok) {
            const result = (await response.json()) as { timeoutSeconds?: number };
            if (result.timeoutSeconds === undefined) return { messageId: messageId as never };
            retrySeconds = result.timeoutSeconds;
          } else await response.body?.cancel();
        } catch (error) {
          if (attempt === 10) throw error;
        }
        if (attempt === 10)
          throw new Error(`World hub dispatch exhausted retries for ${messageId}`);
        await delay(Math.max(0, retrySeconds ?? Math.min(60, 2 ** (attempt - 1))) * 1000);
      }
      throw new Error("Unreachable dispatch state");
    };
    void deliver().catch((error) => {
      if (options.onDeliveryError) options.onDeliveryError(error, messageId);
      else console.error("World hub dispatch failed", messageId, error);
    });
    return { messageId: messageId as never };
  };
}
