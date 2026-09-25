import type { SessionAuthContext } from "#channel/types.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { tooManyTasks } from "#tasks/owner-calls.js";
import type { TaskError } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderSendReceipt,
  renderStartReceipt,
  renderUnconfirmedSendReceipt,
  type TaskReceipt,
} from "#tasks/render.js";
import type { TaskTable } from "#tasks/table.js";

// Immediate tool results of calls the turn does not wait for. Clients read
// the structured receipt; the model reads its text.

/** Receipt of a call that started a detached task. */
export function startReceiptResult(
  record: Pick<TaskRecord, "callId" | "id" | "name" | "resumable">,
  toolName: string,
): RuntimeToolResultActionResult {
  return receiptResult(record.callId, record.id, toolName, renderStartReceipt(record, toolName));
}

/**
 * Receipt of a send: to a working task, to an idle one it started again
 * (`started`), or to a working agent that may not have received it
 * (`unconfirmed`), which stays queued like any send.
 */
export function sendReceiptResult(input: {
  readonly callId: string;
  readonly record: Pick<TaskRecord, "id">;
  readonly started: boolean;
  readonly toolName: string;
  readonly unconfirmed?: boolean;
}): RuntimeToolResultActionResult {
  return receiptResult(
    input.callId,
    input.record.id,
    input.toolName,
    input.unconfirmed === true
      ? renderUnconfirmedSendReceipt(input.record)
      : renderSendReceipt(input.record, input.started),
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
  readonly caller: SessionAuthContext | null;
  readonly table: TaskTable;
  readonly toolName: string;
}): RuntimeToolResultActionResult | undefined {
  const error = tooManyTasks(input.table, input.caller);
  return error === undefined ? undefined : taskToolErrorResult(input, error);
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
