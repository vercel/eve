import type { HarnessSession as RuntimeSession } from "#harness/types.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { taskViewsToJson } from "#tasks/json.js";
import {
  readWorkflowTaskView,
  findTaskInvocation,
  type TaskWorkflowInvocation,
} from "#harness/workflow-invocations.js";
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
  | { readonly entries: TaskWorkflowInvocation[]; readonly kind: "found" }
  | { readonly kind: "unknown"; readonly unknown: string[] } {
  const entries: TaskWorkflowInvocation[] = [];
  const unknown: string[] = [];
  for (const taskId of taskIds) {
    const entry = findTaskInvocation(session.state, taskId);
    if (entry === undefined) {
      unknown.push(taskId);
    } else {
      entries.push(entry);
    }
  }
  return unknown.length > 0 ? { kind: "unknown", unknown } : { entries, kind: "found" };
}

/** Reads the latest view of every entry, defaulting to `working`. */
export async function readTaskViews(
  entries: readonly TaskWorkflowInvocation[],
): Promise<TaskView[]> {
  return Promise.all(entries.map(readTaskView));
}

export async function readTaskView(entry: TaskWorkflowInvocation): Promise<TaskView> {
  try {
    return (
      (await readLatestTaskView({ taskRunId: entry.address.runId })) ?? createPendingTaskView(entry)
    );
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) {
      const retained = readWorkflowTaskView(entry.task);
      if (retained !== undefined) return retained;
    }
    throw error;
  }
}

/** The placeholder view for a run that has not published anything yet. */
function createPendingTaskView(entry: TaskWorkflowInvocation): TaskView {
  return {
    metadata: entry.task.metadata,
    status: "working",
    taskId: entry.task.taskId,
  };
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
