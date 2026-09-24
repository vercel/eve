import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import type { TaskError } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderStartReceipt,
  renderSteeringReceipt,
  renderTooManyTasks,
  type TaskReceipt,
} from "#tasks/render.js";
import { MAX_WORKING_TASKS, workingDetachedTaskIds, type TaskTable } from "#tasks/table.js";

// Immediate tool results of calls the turn does not wait for. Clients read
// the structured receipt; the model reads its text.

/** Receipt of a call that started a detached task. */
export function startReceiptResult(
  record: Pick<TaskRecord, "callId" | "id">,
  toolName: string,
): RuntimeToolResultActionResult {
  return receiptResult(record.callId, record.id, toolName, renderStartReceipt(record));
}

/** Receipt of a call that sent a message to a working agent. */
export function steeringReceiptResult(input: {
  readonly callId: string;
  readonly record: Pick<TaskRecord, "id">;
  readonly toolName: string;
}): RuntimeToolResultActionResult {
  return receiptResult(
    input.callId,
    input.record.id,
    input.toolName,
    renderSteeringReceipt(input.record),
  );
}

function receiptResult(
  callId: string,
  taskId: string,
  toolName: string,
  modelOutput: string,
): RuntimeToolResultActionResult {
  const receipt: TaskReceipt = { status: "working", taskId };
  return { callId, kind: "tool-result", modelOutput, output: { ...receipt }, toolName };
}

/**
 * The error result of a detached start over the cap, or `undefined` when the
 * call may start. Every working detached generation counts.
 */
export function tooManyTasksResult(input: {
  readonly callId: string;
  readonly table: TaskTable;
  readonly toolName: string;
}): RuntimeToolResultActionResult | undefined {
  const working = workingDetachedTaskIds(input.table);
  if (working.length < MAX_WORKING_TASKS) return undefined;
  return {
    callId: input.callId,
    isError: true,
    kind: "tool-result",
    output: { code: "TOO_MANY_TASKS", message: renderTooManyTasks(working, MAX_WORKING_TASKS) },
    toolName: input.toolName,
  };
}

/** The error result of a `task_wait` or `task_cancel` call, such as `UNKNOWN_TASK`. */
export function taskToolErrorResult(
  request: Pick<RuntimeWorkflowTaskRequest, "callId" | "toolName">,
  error: TaskError,
): RuntimeToolResultActionResult {
  return {
    callId: request.callId,
    isError: true,
    kind: "tool-result",
    output: { code: error.code, message: error.message },
    toolName: request.toolName,
  };
}
