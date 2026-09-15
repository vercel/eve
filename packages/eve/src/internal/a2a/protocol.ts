import type { AgentInvocation } from "#internal/invocation/agent-invocation.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_DEFAULT_ROUTE = "/eve/v1/a2a";

export interface A2APart {
  readonly data?: JsonValue;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly metadata?: JsonObject;
  readonly raw?: string;
  readonly text?: string;
  readonly url?: string;
}

export interface A2AMessage {
  readonly contextId?: string;
  readonly extensions?: readonly string[];
  readonly messageId: string;
  readonly metadata?: JsonObject;
  readonly parts: readonly A2APart[];
  readonly referenceTaskIds?: readonly string[];
  readonly role: "ROLE_AGENT" | "ROLE_USER";
  readonly taskId?: string;
}

export interface A2AArtifact {
  readonly artifactId: string;
  readonly description?: string;
  readonly name?: string;
  readonly parts: readonly A2APart[];
}

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export interface A2ATask {
  readonly artifacts?: readonly A2AArtifact[];
  readonly contextId: string;
  readonly history?: readonly A2AMessage[];
  readonly id: string;
  readonly status: {
    readonly message?: A2AMessage;
    readonly state: A2ATaskState;
    readonly timestamp?: string;
  };
}

export interface JsonRpcRequest {
  readonly id: JsonValue;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export function invocationToTask(invocation: AgentInvocation): A2ATask {
  const base = { contextId: invocation.invocationId, id: invocation.invocationId };
  switch (invocation.status) {
    case "working":
      return { ...base, status: { state: "TASK_STATE_WORKING" } };
    case "input_required":
      return {
        ...base,
        status: {
          message: agentMessage(invocation.invocationId, [
            {
              text: Object.values(invocation.inputRequests)
                .map((item) => item.prompt)
                .join("\n"),
            },
            { data: { requests: Object.values(invocation.inputRequests) } },
          ]),
          state: "TASK_STATE_INPUT_REQUIRED",
        },
      };
    case "authorization_required":
      return {
        ...base,
        status: {
          message: agentMessage(invocation.invocationId, [
            {
              text: invocation.authorizations
                .map((item) => item.authorization?.instructions ?? item.description)
                .join("\n"),
            },
            { data: { authorizations: parseJsonValue(invocation.authorizations) } },
          ]),
          state: "TASK_STATE_AUTH_REQUIRED",
        },
      };
    case "completed": {
      const task: {
        artifacts?: readonly A2AArtifact[];
        contextId: string;
        id: string;
        status: A2ATask["status"];
      } = {
        ...base,
        status: { state: "TASK_STATE_COMPLETED" },
      };
      const result = invocation.result;
      if (result !== undefined) {
        task.artifacts = [
          {
            artifactId: `${invocation.invocationId}:result`,
            name: "result",
            parts: [typeof result === "string" ? { text: result } : { data: result }],
          },
        ];
      }
      return task;
    }
    case "failed":
      return {
        ...base,
        status: {
          message: agentMessage(invocation.invocationId, [{ text: invocation.error.message }]),
          state: "TASK_STATE_FAILED",
        },
      };
    case "cancelled":
      return { ...base, status: { state: "TASK_STATE_CANCELED" } };
  }
}

export function parseClientMessage(value: unknown): A2AMessage {
  if (!isRecord(value)) throw new A2ARequestError(-32602, "Invalid parameters");
  if (
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    value.role !== "ROLE_USER" ||
    !Array.isArray(value.parts) ||
    value.parts.length === 0
  ) {
    throw new A2ARequestError(-32602, "Invalid parameters");
  }
  const message: {
    contextId?: string;
    messageId: string;
    parts: readonly A2APart[];
    role: "ROLE_USER";
    taskId?: string;
  } = {
    messageId: value.messageId,
    parts: value.parts.map(parsePart),
    role: "ROLE_USER",
  };
  if (typeof value.contextId === "string") message.contextId = value.contextId;
  if (typeof value.taskId === "string") message.taskId = value.taskId;
  return message;
}

export function messageText(message: A2AMessage): string {
  return message.parts
    .map((part) => {
      if (part.text !== undefined) return part.text;
      if (part.data !== undefined) return `\n\`\`\`json\n${JSON.stringify(part.data)}\n\`\`\``;
      if (part.url !== undefined) return part.url;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function inputResponses(message: A2AMessage): readonly unknown[] | undefined {
  for (const part of message.parts) {
    if (!isRecord(part.data) || !Array.isArray(part.data.responses)) continue;
    return part.data.responses;
  }
  return undefined;
}

export class A2ARequestError extends Error {
  readonly code: number;
  readonly reason: string | undefined;

  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export function jsonRpcSuccess(id: JsonValue, result: JsonValue): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

export function jsonRpcError(id: JsonValue | null, error: unknown): Response {
  const known = error instanceof A2ARequestError ? error : undefined;
  const code = known?.code ?? -32603;
  const message = known?.message ?? "Internal error";
  const data =
    known?.reason === undefined
      ? undefined
      : [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "a2a-protocol.org",
            reason: known.reason,
          },
        ];
  const jsonRpcError: {
    code: number;
    data?: readonly JsonObject[];
    message: string;
  } = { code, message };
  if (data !== undefined) jsonRpcError.data = data;
  return Response.json({ error: jsonRpcError, id, jsonrpc: "2.0" });
}

function agentMessage(contextId: string, parts: readonly A2APart[]): A2AMessage {
  return { contextId, messageId: crypto.randomUUID(), parts, role: "ROLE_AGENT" };
}

function parsePart(value: unknown): A2APart {
  if (!isRecord(value)) throw invalidParams();
  const content = ["text", "data", "url", "raw"].filter((key) => value[key] !== undefined);
  if (content.length !== 1) throw invalidParams();
  if (value.raw !== undefined) {
    if (typeof value.raw !== "string") throw invalidParams();
    throw new A2ARequestError(-32005, "Content type not supported", "CONTENT_TYPE_NOT_SUPPORTED");
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string") throw invalidParams();
    return { text: value.text };
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string") throw invalidParams();
    return { url: value.url };
  }
  try {
    return { data: parseJsonValue(value.data) };
  } catch {
    throw invalidParams();
  }
}

function invalidParams(): A2ARequestError {
  return new A2ARequestError(-32602, "Invalid parameters");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
