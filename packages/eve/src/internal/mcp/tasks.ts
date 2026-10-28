import type { McpJsonObject } from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import {
  McpProtocolError,
  type McpFeatureRequest,
  type McpServerFeature,
} from "#internal/mcp/streamable-http-server.js";

/**
 * MCP's Tasks extension (SEP-2663): a `tools/call` answered with a task
 * handle, then read with `tasks/get`, answered with `tasks/update`, stopped
 * with `tasks/cancel`, and followed with `subscriptions/listen`.
 *
 * The SDK only knows the 2025-11-25 tasks methods and refuses them on
 * 2026-07-28, so eve serves them here, before the SDK sees the request.
 */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const SSE_KEEP_ALIVE_MS = 15_000;

/** One task as `tasks/get` returns it: the extension's `DetailedTask`. */
export type McpTask = McpJsonObject & { readonly taskId: string; readonly status: string };

/** Where tasks come from. Each call checks that `auth` may see the task. */
export interface McpTaskSource {
  /**
   * Starts a task for a `tools/call` from a client that declared the
   * extension. `undefined` leaves the call to the tool itself, as for tools
   * that do not run as tasks or arguments the tool should reject.
   */
  start(
    auth: SessionAuthContext | null,
    call: { readonly arguments: unknown; readonly name: unknown },
  ): Promise<McpTask | undefined>;
  get(auth: SessionAuthContext | null, taskId: string): Promise<McpTask | undefined>;
  /** Delivers `inputResponses`; throws `McpProtocolError` for answers it cannot take. */
  update(
    auth: SessionAuthContext | null,
    taskId: string,
    inputResponses: Readonly<Record<string, unknown>>,
  ): Promise<"updated" | "not_found">;
  cancel(auth: SessionAuthContext | null, taskId: string): Promise<"cancelled" | "not_found">;
  /** The task's state now, then each change, ending after a terminal status. Empty when unknown. */
  watch(
    auth: SessionAuthContext | null,
    taskId: string,
    signal: AbortSignal,
  ): AsyncIterable<McpTask>;
}

/** Whether a request declared the Tasks extension, which lets a `tools/call` answer with a task. */
function declaresTasksExtension(clientCapabilities: unknown): boolean {
  if (!isRecord(clientCapabilities) || !isRecord(clientCapabilities.extensions)) return false;
  return isRecord(clientCapabilities.extensions[MCP_TASKS_EXTENSION]);
}

export function createMcpTasksFeature(source: McpTaskSource): McpServerFeature {
  return {
    capabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
    methods: {
      // Served here rather than by the tool: the SDK rejects a task result from a tool with an output schema.
      "tools/call": async (request) => {
        if (!declaresTasksExtension(request.clientCapabilities)) return undefined;
        const task = await source.start(request.auth, {
          arguments: request.params.arguments ?? {},
          name: request.params.name,
        });
        return task === undefined ? undefined : { ...task, resultType: "task" };
      },
      "subscriptions/listen": async (request) => {
        const taskIds = listenedTaskIds(request.params);
        // Without task IDs this is a list-changed subscription, which the SDK serves.
        if (taskIds === undefined) return undefined;
        requireTasksExtension(request);
        return listen(source, request, taskIds);
      },
      "tasks/cancel": async (request) => {
        const taskId = requestedTaskId(request);
        if ((await source.cancel(request.auth, taskId)) === "not_found") throw taskNotFound();
        return {};
      },
      "tasks/get": async (request) => {
        const task = await source.get(request.auth, requestedTaskId(request));
        if (task === undefined) throw taskNotFound();
        return task;
      },
      "tasks/update": async (request) => {
        const taskId = requestedTaskId(request);
        const { inputResponses } = request.params;
        if (!isRecord(inputResponses)) {
          throw new McpProtocolError(-32602, "tasks/update requires an inputResponses object.");
        }
        if ((await source.update(request.auth, taskId, inputResponses)) === "not_found") {
          throw taskNotFound();
        }
        return {};
      },
    },
  };
}

function requestedTaskId(request: McpFeatureRequest): string {
  requireTasksExtension(request);
  const { taskId } = request.params;
  if (typeof taskId !== "string") throw new McpProtocolError(-32602, "taskId must be a string.");
  if (request.name !== taskId) {
    throw new McpProtocolError(
      -32020,
      "Bad Request: the Mcp-Name header must equal params.taskId.",
    );
  }
  return taskId;
}

function requireTasksExtension(request: McpFeatureRequest): void {
  if (declaresTasksExtension(request.clientCapabilities)) return;
  throw new McpProtocolError(-32021, "Missing required client capability", {
    requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
  });
}

function taskNotFound(): McpProtocolError {
  return new McpProtocolError(
    -32602,
    "Task not found. It may have expired or belong to another caller.",
  );
}

function listenedTaskIds(params: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  const { notifications } = params;
  if (!isRecord(notifications) || !Array.isArray(notifications.taskIds)) return undefined;
  return notifications.taskIds.filter((id): id is string => typeof id === "string");
}

/**
 * Serves one `subscriptions/listen` for tasks over SSE: an acknowledgement
 * naming the tasks it follows, each task's current state, a
 * `notifications/tasks` per change, then a graceful close once every task
 * is terminal. Every notification is a full task, so a client that
 * reconnects only needs to listen again.
 */
function listen(
  source: McpTaskSource,
  request: McpFeatureRequest,
  taskIds: readonly string[],
): Response {
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  request.signal.addEventListener("abort", stop, { once: true });
  const encoder = new TextEncoder();
  const subscription = { [SUBSCRIPTION_ID_META_KEY]: request.id };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (message: McpJsonObject) => {
        if (stopped.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      };
      const notify = (task: McpTask) =>
        write({
          jsonrpc: "2.0",
          method: "notifications/tasks",
          params: { ...task, _meta: subscription },
        });
      const keepAlive = setInterval(() => {
        if (!stopped.signal.aborted) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, SSE_KEEP_ALIVE_MS);

      try {
        // A task's first state tells whether it is known to this caller; unknown ones are not acknowledged.
        const watches = await Promise.all(
          [...new Set(taskIds)].map(async (taskId) => {
            const updates = source
              .watch(request.auth, taskId, stopped.signal)
              [Symbol.asyncIterator]();
            const first = await updates.next();
            return first.done === true ? undefined : { first: first.value, updates };
          }),
        );
        const followed = watches.filter((watch) => watch !== undefined);
        write({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            _meta: subscription,
            notifications: { taskIds: followed.map((watch) => watch.first.taskId) },
          },
        });
        await Promise.all(
          followed.map(async ({ first, updates }) => {
            notify(first);
            for (let next = await updates.next(); next.done !== true; next = await updates.next()) {
              notify(next.value);
            }
          }),
        );
        write({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            _meta: { ...subscription, [SERVER_INFO_META_KEY]: request.serverInfo },
            resultType: "complete",
          },
        });
      } catch (error) {
        if (!stopped.signal.aborted) controller.error(error);
        return;
      } finally {
        clearInterval(keepAlive);
        request.signal.removeEventListener("abort", stop);
      }
      if (!stopped.signal.aborted) controller.close();
    },
    cancel: stop,
  });

  return new Response(body, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
