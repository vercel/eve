import { InvocationListingLimitError } from "#internal/invocation/agent-invocation.js";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { SessionAuthContext } from "#channel/types.js";
import type { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import {
  A2AError,
  A2A_VERSION,
  isInterruptedTask,
  isTerminalTask,
  listTasksSchema,
  parseParams,
  readBoundedJson,
  rpcRequestSchema,
  sendMessageSchema,
  taskRequestSchema,
  type A2AListTasksRequest,
  type A2ATask,
} from "#internal/a2a/protocol.js";
import {
  inputResponses,
  messageText,
  projectInvocation,
  resultPart,
} from "#internal/a2a/projection.js";

export async function handleA2ARequest(
  request: Request,
  input: {
    readonly auth: SessionAuthContext;
    readonly execution: Pick<
      WorkflowAgentInvocationExecution,
      "create" | "read" | "update" | "cancel" | "history" | "list" | "ownerKey"
    >;
  },
): Promise<Response> {
  let id: string | number | null = null;
  const headers = { "A2A-Version": A2A_VERSION, "cache-control": "no-store" };
  try {
    const envelope = rpcRequestSchema.safeParse(await readBoundedJson(request.body));
    if (!envelope.success) throw new A2AError(-32600, "Invalid Request.");
    id = envelope.data.id;
    const { method, params = {} } = envelope.data;
    const version = request.headers.get("a2a-version");
    if (version !== null && version !== A2A_VERSION)
      throw new A2AError(-32009, "Supported A2A version: 1.0.");
    if (params.tenant !== undefined && params.tenant !== "")
      throw new A2AError(-32602, "This interface does not define a tenant.");
    const read = async (taskId: string, historyLength?: number): Promise<A2ATask> => {
      const invocation = await input.execution.read({ auth: input.auth, invocationId: taskId });
      if (invocation === undefined) throw new A2AError(-32001, "Task not found.");
      const task = projectInvocation(invocation);
      const history = await input.execution.history({
        auth: input.auth,
        invocationId: taskId,
        limit: historyLength,
      });
      if (history.length > 0)
        task.history = history.map((message) => ({
          messageId: message.id,
          role: message.role === "user" ? "ROLE_USER" : "ROLE_AGENT",
          taskId,
          contextId: taskId,
          parts: [resultPart(message.value)],
        }));
      return task;
    };
    let result: unknown;
    switch (method) {
      case "SendMessage":
      case "SendStreamingMessage": {
        const { message, configuration } = parseParams(sendMessageSchema, params);
        const text = messageText(message);
        if (configuration?.taskPushNotificationConfig !== undefined)
          throw new A2AError(-32003, "Push notifications are not supported.");
        if (
          configuration?.acceptedOutputModes?.length &&
          !configuration.acceptedOutputModes.some(
            (mode) => mode === "text/plain" || mode === "application/json",
          )
        ) {
          throw new A2AError(-32005, "Supported output modes: text/plain, application/json.");
        }
        const taskId = message.taskId ?? message.contextId;
        let task: A2ATask;
        if (taskId !== undefined) {
          const current = await input.execution.read({ auth: input.auth, invocationId: taskId });
          if (current === undefined) throw new A2AError(-32001, "Task not found.");
          if (message.contextId !== undefined && message.contextId !== taskId)
            throw new A2AError(-32602, "contextId does not match this task.");
          const updated = await input.execution.update({
            auth: input.auth,
            invocationId: taskId,
            responses: inputResponses(message, current),
          });
          if (updated.type === "not_found") throw new A2AError(-32001, "Task not found.");
          if (updated.type === "conflict") throw new A2AError(-32004, updated.message);
          task = projectInvocation(updated.invocation);
        } else {
          task = projectInvocation(
            await input.execution.create({ auth: input.auth, message: text }),
          );
          task.status.state = "TASK_STATE_SUBMITTED";
        }
        const next = () => read(task.id, configuration?.historyLength);
        if (method === "SendStreamingMessage") return streamTasks(id, task, next, request.signal);
        if (configuration?.returnImmediately !== true) {
          while (!isTerminalTask(task) && !isInterruptedTask(task)) {
            await delay(500, undefined, { signal: request.signal });
            task = await next();
          }
        } else if (configuration?.historyLength !== 0) {
          const snapshot = await read(task.id, configuration?.historyLength);
          task.history = snapshot.history;
        }
        result = { task };
        break;
      }
      case "GetTask": {
        const paramsValue = parseParams(taskRequestSchema, params);
        result = await read(paramsValue.id, paramsValue.historyLength);
        break;
      }
      case "CancelTask": {
        const paramsValue = parseParams(taskRequestSchema, params);
        const current = await read(paramsValue.id, 0);
        if (isTerminalTask(current) && current.status.state !== "TASK_STATE_CANCELED")
          throw new A2AError(-32002, "Task cannot be canceled.");
        const cancelled = await input.execution.cancel({
          auth: input.auth,
          invocationId: paramsValue.id,
        });
        if (cancelled === undefined) throw new A2AError(-32001, "Task not found.");
        result = projectInvocation(cancelled);
        break;
      }
      case "SubscribeToTask": {
        const paramsValue = parseParams(taskRequestSchema, params);
        const task = await read(paramsValue.id, paramsValue.historyLength);
        if (isTerminalTask(task))
          throw new A2AError(-32004, "Cannot subscribe to a terminal task. Use GetTask.");
        return streamTasks(
          id,
          task,
          () => read(task.id, paramsValue.historyLength),
          request.signal,
        );
      }
      case "ListTasks": {
        const filters = parseParams(listTasksSchema, params);
        if (input.auth.principalType === "anonymous" && filters.contextId === undefined) {
          result = { tasks: [], totalSize: 0, pageSize: filters.pageSize, nextPageToken: "" };
          break;
        }
        const invocations =
          filters.contextId === undefined
            ? await input.execution.list({ auth: input.auth })
            : [
                await input.execution.read({ auth: input.auth, invocationId: filters.contextId }),
              ].filter((entry) => entry !== undefined);
        const tasks = invocations
          .map(projectInvocation)
          .filter(
            (task) =>
              (filters.status === undefined || filters.status === task.status.state) &&
              (filters.statusTimestampAfter === undefined ||
                Date.parse(task.status.timestamp ?? "") >=
                  Date.parse(filters.statusTimestampAfter)),
          )
          .sort(
            (a, b) =>
              (b.status.timestamp ?? "").localeCompare(a.status.timestamp ?? "") ||
              a.id.localeCompare(b.id),
          );
        result = await listPage(tasks, filters, input.execution.ownerKey(input.auth), read);
        break;
      }
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        throw new A2AError(-32003, "Push notifications are not supported.");
      case "GetExtendedAgentCard":
        throw new A2AError(-32004, "Extended Agent Cards are not supported.");
      default:
        throw new A2AError(-32601, "Method not found.");
    }
    return Response.json({ jsonrpc: "2.0", id, result }, { headers });
  } catch (error) {
    return Response.json(rpcError(id, error), { headers });
  }
}

async function listPage(
  tasks: A2ATask[],
  filters: A2AListTasksRequest,
  owner: string,
  read: (id: string, length?: number) => Promise<A2ATask>,
) {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([owner, filters.contextId, filters.status, filters.statusTimestampAfter]),
    )
    .digest("hex");
  let offset = 0;
  if (filters.pageToken) {
    try {
      const cursor = JSON.parse(Buffer.from(filters.pageToken, "base64url").toString("utf8"));
      if (
        cursor.fingerprint !== fingerprint ||
        !Number.isInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > 1000
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw new A2AError(-32602, "Invalid page token for this query.");
    }
  }
  const selected: A2ATask[] = [];
  for (const entry of tasks.slice(offset, offset + filters.pageSize)) {
    const task = await read(entry.id, filters.historyLength);
    if (!filters.includeArtifacts) delete task.artifacts;
    selected.push(task);
  }
  const end = offset + selected.length;
  return {
    tasks: selected,
    totalSize: tasks.length,
    pageSize: filters.pageSize,
    nextPageToken:
      end < tasks.length
        ? Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString("base64url")
        : "",
  };
}
function rpcError(id: string | number | null, error: unknown) {
  if (error instanceof InvocationListingLimitError) error = new A2AError(-32004, error.message);
  return {
    jsonrpc: "2.0",
    id,
    error:
      error instanceof A2AError
        ? { code: error.code, message: error.message }
        : { code: -32603, message: "Internal error." },
  };
}
function streamTasks(
  id: string | number,
  initial: A2ATask,
  read: () => Promise<A2ATask>,
  signal: AbortSignal,
): Response {
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const encoder = new TextEncoder();
  let previous = initial;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const send = (result: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`),
        );
      try {
        if (!started) {
          send({ task: initial });
          started = true;
        }
        if (isTerminalTask(previous) || isInterruptedTask(previous)) {
          controller.close();
          return;
        }
        await delay(500, undefined, { signal: combined });
        const task = await read();
        if (JSON.stringify(task.artifacts) !== JSON.stringify(previous.artifacts)) {
          for (const artifact of task.artifacts ?? [])
            send({
              artifactUpdate: {
                taskId: task.id,
                contextId: task.contextId,
                artifact,
                append: false,
                lastChunk: true,
              },
            });
        }
        if (JSON.stringify(task.status) !== JSON.stringify(previous.status))
          send({
            statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status },
          });
        previous = task;
      } catch (error) {
        if (!combined.aborted)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(rpcError(id, error))}\n\n`));
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "A2A-Version": A2A_VERSION,
      "x-accel-buffering": "no",
    },
  });
}
