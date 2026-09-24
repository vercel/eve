import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";

// The model's tool for stopping a detached task. The harness reads this
// module, so it must stay free of Node.js built-ins.

/**
 * Marks the model tool that stops a detached task. Its calls defer like a
 * workflow tool's, and the owner applies them to its task table; nothing with
 * this ID is ever started as a workflow.
 */
export const TASK_CANCEL_WORKFLOW_ID = "eve//task-cancel";

export function isTaskCancelTool(tool: { readonly workflowId?: string } | undefined): boolean {
  return tool?.workflowId === TASK_CANCEL_WORKFLOW_ID;
}

export function isTaskCancelRequest(
  request: Pick<RuntimeWorkflowTaskRequest, "workflowId">,
): boolean {
  return request.workflowId === TASK_CANCEL_WORKFLOW_ID;
}

/** Reads the one task ID of a call: a non-empty, bounded string. Returns `undefined` for anything else. */
export function readTaskCancelId(input: JsonObject): string | undefined {
  const { taskId } = input;
  return typeof taskId === "string" && taskId.length > 0 && taskId.length <= MAX_TASK_ID_LENGTH
    ? taskId
    : undefined;
}
