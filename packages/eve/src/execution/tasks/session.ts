import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  TASK_CANCEL_TOOL_NAME,
  taskToolResult,
  type TaskToolCall,
} from "#execution/tasks/calls.js";
import { renderTaskCancelResult, renderUnknownCancelTaskError } from "#execution/tasks/render.js";
import { cancelTasksStep, type TaskRunMessage } from "#execution/tasks/steps.js";
import {
  readTaskTable,
  taskCancelResult,
  workingTasks,
  type TaskTable,
} from "#execution/tasks/table.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

// What the session's workflow body does with tasks between steps: records
// change only in `steps.ts`, and these decide when to run them. They live apart
// because the workflow bundle keeps only the steps of a step module.

/** Whether a run's message changes a task record. */
export function isTaskRunMessage(message: WorkflowToolRunMessage): message is TaskRunMessage {
  if (message.from.taskId === undefined) return false;
  return message.kind === "started" || message.kind === "reply" || message.kind === "outcome";
}

/** The session's task table as the workflow body last committed it. */
export function sessionTaskTable(cursor: SessionStateCursor): TaskTable {
  return readTaskTable(cursor.sessionState.snapshot.session.state);
}

/**
 * Cancels every working task: a turn that ends anyway, such as by failing,
 * cancels the tasks it held on.
 */
export async function cancelWorkingTasks(cursor: SessionStateCursor): Promise<void> {
  const taskIds = workingTasks(sessionTaskTable(cursor)).map((record) => record.id);
  if (taskIds.length === 0) return;
  await cursor.apply(await cancelTasksStep({ ...cursor.stepState(), taskIds }));
}

export async function answerTaskCancel(
  cursor: SessionStateCursor,
  call: Extract<TaskToolCall, { readonly kind: "task_cancel" }>,
): Promise<RuntimeActionResult> {
  const result = taskCancelResult(sessionTaskTable(cursor), call.taskId);
  if (result === undefined) {
    const error = {
      code: "UNKNOWN_TASK",
      message: renderUnknownCancelTaskError(call.taskId),
    };
    return { ...taskToolResult(call.callId, TASK_CANCEL_TOOL_NAME, error), isError: true };
  }
  if (result.status === "cancelled") {
    await cursor.apply(await cancelTasksStep({ ...cursor.stepState(), taskIds: [call.taskId] }));
  }
  return taskToolResult(
    call.callId,
    TASK_CANCEL_TOOL_NAME,
    renderTaskCancelResult(call.taskId, result),
  );
}
