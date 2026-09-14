import { randomUUID } from "node:crypto";
import { z } from "zod";
import { taskSchema, RpcError, type Task } from "./protocol";
import extension from "../extension";
import { requiredEnv } from "./env";

// Read credentials only at execution time; never return them to the caller.
async function requestRemote(method: string, params: unknown): Promise<unknown> {
  const { origin, username, passwordEnv } = extension.config.remote;
  const headers = {
    authorization: `Basic ${Buffer.from(`${username}:${requiredEnv(passwordEnv)}`).toString("base64")}`,
    "content-type": "application/json",
    "a2a-version": "1.0",
  };
  const cardResponse = await fetch(new URL("/.well-known/agent-card.json", origin), {
    headers,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!cardResponse.ok) throw new Error(`Agent Card HTTP ${cardResponse.status}`);
  const card = z
    .object({
      supportedInterfaces: z.array(
        z.object({
          url: z.string().url(),
          protocolBinding: z.string(),
          protocolVersion: z.string(),
        }),
      ),
    })
    .parse(await cardResponse.json());
  const endpoint = card.supportedInterfaces.find(
    (entry) => entry.protocolBinding === "JSONRPC" && entry.protocolVersion === "1.0",
  );
  if (!endpoint || new URL(endpoint.url).origin !== new URL(origin).origin)
    throw new Error("Expected a same-origin A2A 1.0 JSON-RPC interface");
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`A2A HTTP ${response.status}`);
  const rpc = z
    .object({
      result: z.unknown().optional(),
      error: z.object({ code: z.number(), message: z.string() }).optional(),
    })
    .parse(await response.json());
  if (rpc.error) throw new RpcError(rpc.error.code, rpc.error.message);
  return rpc.result;
}

export async function sendRemote(message: string, taskId?: string): Promise<Task> {
  const result = await requestRemote("SendMessage", {
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: message }],
      taskId,
    },
    configuration: { returnImmediately: true },
  });
  return z.object({ task: taskSchema }).parse(result).task;
}

export async function readRemote(taskId: string): Promise<Task> {
  return taskSchema.parse(await requestRemote("GetTask", { id: taskId }));
}

export async function cancelRemote(taskId: string): Promise<Task> {
  return taskSchema.parse(await requestRemote("CancelTask", { id: taskId }));
}
