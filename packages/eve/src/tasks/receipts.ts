import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import type { TaskError } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderBackgroundReceipt,
  renderSteeringReceipt,
  renderTooManyBackgroundTasks,
  type TaskReceipt,
} from "#tasks/render.js";
import { MAX_BACKGROUND_TASKS, workingBackgroundTaskIds } from "#tasks/results.js";
import type { TaskTable } from "#tasks/table.js";

// Immediate tool results of calls the turn does not wait for. Clients read
// the structured receipt; the model reads its text.

/** Receipt of an agent call with `background: true`. */
export function backgroundReceiptResult(
  record: Pick<TaskRecord, "callId" | "id">,
  toolName: string,
): RuntimeToolResultActionResult {
  const receipt: TaskReceipt = { status: "working", taskId: record.id };
  return {
    callId: record.callId,
    kind: "tool-result",
    modelOutput: renderBackgroundReceipt(record),
    output: { ...receipt },
    toolName,
  };
}

/** Receipt of a call that sent a message to a working agent. */
export function steeringReceiptResult(input: {
  readonly callId: string;
  readonly record: Pick<TaskRecord, "id" | "mode">;
  readonly toolName: string;
}): RuntimeToolResultActionResult {
  const receipt: TaskReceipt = { status: "working", taskId: input.record.id };
  return {
    callId: input.callId,
    kind: "tool-result",
    modelOutput: renderSteeringReceipt(input.record),
    output: { ...receipt },
    toolName: input.toolName,
  };
}

/**
 * The error result of a background agent call over the cap, or `undefined`
 * when the call may start. Detached calls count toward the cap, but a detach
 * is never rejected.
 */
export function tooManyBackgroundTasksResult(input: {
  readonly callId: string;
  readonly table: TaskTable;
  readonly toolName: string;
}): RuntimeToolResultActionResult | undefined {
  const working = workingBackgroundTaskIds(input.table);
  if (working.length < MAX_BACKGROUND_TASKS) return undefined;
  return {
    callId: input.callId,
    isError: true,
    kind: "tool-result",
    output: {
      code: "TOO_MANY_BACKGROUND_TASKS",
      message: renderTooManyBackgroundTasks(working, MAX_BACKGROUND_TASKS),
    },
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
