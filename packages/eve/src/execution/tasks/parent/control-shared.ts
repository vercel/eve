import type { HarnessSession as RuntimeSession } from "#harness/types.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { taskViewsToJson } from "#tasks/json.js";
import {
  findBackgroundWorkflowToolRun,
  type BackgroundWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import type { TaskView } from "#tasks/types.js";

/**
 * Result and lookup helpers shared by the task-control executors
 * (`task_cancel` in the dispatch module,
 * task controls in their own).
 */

/** Resolves owned index entries, or the ids this session does not own. */
export function lookupTaskEntries(
  session: RuntimeSession,
  taskIds: readonly string[],
):
  | { readonly entries: BackgroundWorkflowToolRun[]; readonly kind: "found" }
  | { readonly kind: "unknown"; readonly unknown: string[] } {
  const entries: BackgroundWorkflowToolRun[] = [];
  const unknown: string[] = [];
  for (const taskId of taskIds) {
    const entry = findBackgroundWorkflowToolRun(session.state, taskId);
    if (entry === undefined) {
      unknown.push(taskId);
    } else {
      entries.push(entry);
    }
  }
  return unknown.length > 0 ? { kind: "unknown", unknown } : { entries, kind: "found" };
}

/** One successful task-control result carrying full task views. */
export function createTaskViewsResult(
  action: RuntimeToolCallActionRequest,
  views: readonly TaskView[],
): RuntimeActionResult {
  return {
    callId: action.callId,
    kind: "tool-result",
    output: taskViewsToJson(views),
    toolName: action.toolName,
  };
}

/** One task-control error the model can act on. */
export function createTaskControlError(
  action: RuntimeToolCallActionRequest,
  message: string,
): RuntimeActionResult {
  return {
    callId: action.callId,
    isError: true,
    kind: "tool-result",
    output: { message },
    toolName: action.toolName,
  };
}

/** The ownership error for ids outside this session's task index. */
export function createUnknownTasksError(
  action: RuntimeToolCallActionRequest,
  unknown: readonly string[],
): RuntimeActionResult {
  return createTaskControlError(
    action,
    `Unknown task ids: ${unknown.join(", ")}. Tasks belong to the session that created them.`,
  );
}
