/**
 * The A2A v1.0 JSON-RPC binding: one POST endpoint, PascalCase methods, A2A errors as JSON-RPC
 * error objects, and Server-Sent Events for the streaming methods. Push-notification config is
 * refused: the Agent Card doesn't advertise it.
 */
import type { SessionAuthContext } from "#channel/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";

import type { A2aCallContext, A2aTaskExecution } from "./execution.js";
import {
  A2A_ABSENT_VERSION,
  A2A_JSON_RPC_ERRORS,
  A2A_PROTOCOL_VERSION,
  A2aError,
  cancelTaskRequestSchema,
  getTaskRequestSchema,
  jsonRpcRequestSchema,
  listTasksRequestSchema,
  sendMessageRequestSchema,
  subscribeToTaskRequestSchema,
  type A2aErrorDetail,
  type JsonRpcId,
  type StreamResponse,
} from "./protocol.js";

const log = createLogger("channel.a2a");

/** Cap on a request body; A2A parts can carry inline files, so this is larger than MCP's. */
export const A2A_REQUEST_BODY_MAX_BYTES = 32 * 1_024 * 1_024;

/** An SSE comment this often keeps idle proxies from closing a quiet stream. */
const STREAM_HEARTBEAT_MS = 15_000;

const PUSH_NOTIFICATION_METHODS = new Set([
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
]);

/** The task operations the binding dispatches to. */
export type A2aOperations = Pick<
  A2aTaskExecution,
  "cancelTask" | "getTask" | "listTasks" | "sendMessage" | "streamMessage" | "subscribe"
>;

export async function handleA2aJsonRpc(
  request: Request,
  auth: SessionAuthContext | null,
  execution: A2aOperations,
): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (contentType !== null && !isJsonMediaType(contentType)) {
    return rpcError(
      null,
      new A2aError(
        A2A_JSON_RPC_ERRORS.contentTypeNotSupported,
        `Content-Type ${contentType} is not supported; send application/json.`,
      ),
    );
  }
  const body = await readJsonBody(request);
  if (body instanceof A2aError) return rpcError(null, body);
  if (Array.isArray(body)) {
    return rpcError(
      null,
      new A2aError(A2A_JSON_RPC_ERRORS.invalidRequest, "Batch requests are not supported."),
    );
  }
  const envelope = jsonRpcRequestSchema.safeParse(body);
  if (!envelope.success) {
    return rpcError(null, new A2aError(A2A_JSON_RPC_ERRORS.invalidRequest, "Invalid request."));
  }
  const { id = null, method, params } = envelope.data;
  const versionFailure = checkVersion(request);
  if (versionFailure !== undefined) return rpcError(id, versionFailure);

  // Streams outlive this function; their own controller stops them when the client cancels.
  const stop = new AbortController();
  const call: A2aCallContext = {
    auth,
    signal: AbortSignal.any([request.signal, stop.signal]),
  };
  const headers = responseHeaders();
  try {
    switch (method) {
      case "SendStreamingMessage": {
        const events = await execution.streamMessage(parse(sendMessageRequestSchema, params), call);
        return sseResponse(id, events, stop, headers);
      }
      case "SubscribeToTask": {
        const events = await execution.subscribe(parse(subscribeToTaskRequestSchema, params), call);
        return sseResponse(id, events, stop, headers);
      }
      default: {
        const result = await dispatch(method, params, call, execution);
        return Response.json({ id, jsonrpc: "2.0", result }, { headers });
      }
    }
  } catch (error) {
    return rpcError(id, asA2aError(error, method), headers);
  }
}

async function dispatch(
  method: string,
  params: unknown,
  call: A2aCallContext,
  execution: A2aOperations,
): Promise<unknown> {
  switch (method) {
    case "SendMessage":
      // SendMessageResponse is a oneof: eve always answers with a task.
      return { task: await execution.sendMessage(parse(sendMessageRequestSchema, params), call) };
    case "GetTask":
      return await execution.getTask(parse(getTaskRequestSchema, params), call);
    case "CancelTask":
      return await execution.cancelTask(parse(cancelTaskRequestSchema, params), call);
    case "ListTasks":
      return await execution.listTasks(parse(listTasksRequestSchema, params), call);
    case "GetExtendedAgentCard":
      // The card says `extendedAgentCard: false` (spec 3.3.4).
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.unsupportedOperation,
        "This agent has no extended Agent Card.",
      );
    default:
      if (PUSH_NOTIFICATION_METHODS.has(method)) {
        throw new A2aError(
          A2A_JSON_RPC_ERRORS.pushNotificationNotSupported,
          "Push notifications are not supported.",
        );
      }
      throw new A2aError(A2A_JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

function parse<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
  },
  params: unknown,
): T {
  const result = schema.safeParse(protoJsonNames(params ?? {}));
  if (result.success) return result.data;
  throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Invalid params.", {
    details: [badRequest(result.error.issues as readonly ParamsIssue[])],
  });
}

/**
 * `application/json`, or a JSON type such as `application/a2a+json`. An absent header passes:
 * only a declared non-JSON body is refused.
 */
function isJsonMediaType(contentType: string): boolean {
  const essence = contentType.split(";")[0]!.trim().toLowerCase();
  return essence === "application/json" || /^application\/[\w.+-]+\+json$/u.test(essence);
}

/**
 * ProtoJSON parsers accept a field's original proto name as well as its lowerCamelCase JSON
 * name, so `history_length` reads as `historyLength`. Free-form values (`metadata`, and a data
 * part's `data`) are application JSON and keep their keys; a camelCase key wins over its
 * snake_case twin.
 */
function protoJsonNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protoJsonNames);
  if (value === null || typeof value !== "object") return value;
  const renamed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = key.replace(/_([a-z0-9])/gu, (_, next: string) => next.toUpperCase());
    // `__proto__` names no protocol field, and assigning it would replace the prototype.
    if (name === "__proto__" || (name !== key && Object.hasOwn(value, name))) continue;
    renamed[name] = FREE_FORM_FIELDS.has(name) ? entry : protoJsonNames(entry);
  }
  return renamed;
}

const FREE_FORM_FIELDS: ReadonlySet<string> = new Set(["data", "metadata"]);

function asA2aError(error: unknown, method: string): A2aError {
  if (error instanceof A2aError) return error;
  const errorId = createErrorId();
  log.error("A2A request failed", { error, errorId, method });
  // The ID ties the response to the logged error; nothing else about the failure leaves.
  return new A2aError(A2A_JSON_RPC_ERRORS.internalError, "Internal error.", {
    details: [{ "@type": "type.googleapis.com/google.rpc.RequestInfo", requestId: errorId }],
  });
}

interface ParamsIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

/** Schema issues as a `google.rpc.BadRequest`, fields in the camelCase JSON names. */
function badRequest(issues: readonly ParamsIssue[]): A2aErrorDetail {
  return {
    "@type": "type.googleapis.com/google.rpc.BadRequest",
    fieldViolations: issues.map((issue) => ({
      description: issue.message,
      field: issue.path.map(String).join("."),
    })),
  };
}

/**
 * `A2A-Version` (header, or query parameter) must name this agent's `Major.Minor`. An empty one
 * means 0.3, which this agent doesn't speak (spec 3.2.6).
 */
function checkVersion(request: Request): A2aError | undefined {
  const raw =
    request.headers.get("a2a-version") ?? new URL(request.url).searchParams.get("A2A-Version");
  const requested = raw === null || raw.trim() === "" ? A2A_ABSENT_VERSION : raw.trim();
  const majorMinor = /^(\d+)\.(\d+)$/u.exec(requested);
  if (majorMinor !== null && `${majorMinor[1]}.${majorMinor[2]}` === A2A_PROTOCOL_VERSION) {
    return undefined;
  }
  return new A2aError(
    A2A_JSON_RPC_ERRORS.versionNotSupported,
    `A2A version ${requested} is not supported. Send A2A-Version: ${A2A_PROTOCOL_VERSION}.`,
    { metadata: { supportedVersions: A2A_PROTOCOL_VERSION } },
  );
}

function responseHeaders(): Headers {
  return new Headers({ "a2a-version": A2A_PROTOCOL_VERSION, "cache-control": "no-store" });
}

/** Reads the body, counting bytes as they stream: a declared length is only a fast refusal. */
async function readJsonBody(request: Request): Promise<unknown> {
  const tooLarge = () =>
    new A2aError(
      A2A_JSON_RPC_ERRORS.invalidRequest,
      `Request body exceeds ${A2A_REQUEST_BODY_MAX_BYTES} bytes.`,
    );
  const body = request.body;
  if (body === null) return new A2aError(A2A_JSON_RPC_ERRORS.parseError, "Parse error.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > A2A_REQUEST_BODY_MAX_BYTES) {
    await body.cancel().catch(() => {});
    return tooLarge();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > A2A_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return new A2aError(A2A_JSON_RPC_ERRORS.parseError, "Parse error.");
  }
}

/**
 * Streams `events` as SSE, one JSON-RPC response per `data:` event. A failure mid-stream is sent
 * as a final JSON-RPC error event; a client that cancels the body stops the follower.
 */
function sseResponse(
  id: JsonRpcId,
  events: AsyncIterable<StreamResponse>,
  stop: AbortController,
  headers: Headers,
): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, STREAM_HEARTBEAT_MS);
    },
    async pull(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        const next = await iterator.next();
        if (next.done) {
          clearInterval(heartbeat);
          controller.close();
          return;
        }
        send({ id, jsonrpc: "2.0", result: next.value });
      } catch (error) {
        clearInterval(heartbeat);
        const failure = asA2aError(error, "stream");
        send({ error: errorObject(failure), id, jsonrpc: "2.0" });
        controller.close();
      }
    },
    async cancel() {
      clearInterval(heartbeat);
      stop.abort();
      await iterator.return?.();
    },
  });
  headers.set("content-type", "text/event-stream");
  headers.set("x-accel-buffering", "no");
  return new Response(body, { headers });
}

function errorObject(error: A2aError) {
  return {
    code: error.code,
    message: error.message,
    ...(error.data !== undefined && { data: error.data }),
  };
}

function rpcError(id: JsonRpcId, error: A2aError, headers?: Headers): Response {
  return Response.json(
    { error: errorObject(error), id, jsonrpc: "2.0" },
    { headers: headers ?? responseHeaders() },
  );
}
