import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";

// The model's tool for stopping background tasks. The harness reads this
// module, so it must stay free of Node.js built-ins.

/**
 * Marks the model tool that stops background tasks. Its calls defer like a
 * workflow tool's, and the owner applies them to its task table; nothing with
 * this ID is ever started as a workflow.
 */
export const TASK_CANCEL_WORKFLOW_ID = "eve//task-cancel";

/** Most IDs one call accepts. */
export const MAX_TASK_CANCEL_IDS = 50;

export function isTaskCancelTool(tool: { readonly workflowId?: string } | undefined): boolean {
  return tool?.workflowId === TASK_CANCEL_WORKFLOW_ID;
}

export function isTaskCancelRequest(
  request: Pick<RuntimeWorkflowTaskRequest, "workflowId">,
): boolean {
  return request.workflowId === TASK_CANCEL_WORKFLOW_ID;
}

/**
 * Reads the IDs of one call: a non-empty, bounded list of non-empty, bounded
 * strings. Returns `undefined` for anything else.
 */
export function readTaskCancelIds(input: JsonObject): readonly string[] | undefined {
  const { taskIds } = input;
  if (
    !Array.isArray(taskIds) ||
    taskIds.length === 0 ||
    taskIds.length > MAX_TASK_CANCEL_IDS ||
    !taskIds.every(
      (taskId) =>
        typeof taskId === "string" && taskId.length > 0 && taskId.length <= MAX_TASK_ID_LENGTH,
    )
  ) {
    return undefined;
  }
  return taskIds as readonly string[];
}
