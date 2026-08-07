import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { isFinishedTaskRunTarget, readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { taskViewsToJson } from "#tasks/json.js";
import {
  findSessionTaskEntry,
  getSessionTaskIndex,
  type SessionTaskIndexEntry,
} from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";

/**
 * Result and lookup helpers shared by the task-control executors
 * (`task_peek`/`task_cancel` in the dispatch module,
 * `task_send` in its own).
 */

/** Resolves owned index entries, or the ids this session does not own. */
export function lookupTaskEntries(
  session: RuntimeSession,
  taskIds: readonly string[],
):
  | { readonly entries: SessionTaskIndexEntry[]; readonly kind: "found" }
  | { readonly kind: "unknown"; readonly unknown: string[] } {
  const entries: SessionTaskIndexEntry[] = [];
  const unknown: string[] = [];
  for (const taskId of taskIds) {
    const entry = findSessionTaskEntry(session.state, taskId);
    if (entry === undefined) {
      unknown.push(taskId);
    } else {
      entries.push(entry);
    }
  }
  return unknown.length > 0 ? { kind: "unknown", unknown } : { entries, kind: "found" };
}

/** Reads the latest snapshot of every entry, defaulting to `working`. */
export async function readTaskViews(
  entries: readonly SessionTaskIndexEntry[],
): Promise<TaskView[]> {
  return Promise.all(entries.map(readTaskView));
}

async function readTaskView(entry: SessionTaskIndexEntry): Promise<TaskView> {
  try {
    return (
      (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ?? createPendingTaskView(entry)
    );
  } catch (error) {
    if (isFinishedTaskRunTarget(error) && entry.terminalSnapshot !== undefined) {
      return entry.terminalSnapshot;
    }
    throw error;
  }
}

/** The view of a run that has not published its first snapshot yet. */
export function createPendingTaskView(entry: SessionTaskIndexEntry): TaskView {
  return {
    metadata: entry.metadata,
    status: "working",
    taskId: entry.taskId,
  };
}

/** Finds the persistent address record for one task-owned agent. */
export function findTaskAgentAddress(
  session: RuntimeSession,
  agentId: string,
): Extract<AgentHandle, { phase: "addressed" }> | undefined {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  return handles.find(
    (candidate): candidate is Extract<AgentHandle, { phase: "addressed" }> =>
      candidate.phase === "addressed" && candidate.identity.id === agentId,
  );
}

/** Returns the one nonterminal task owning an agent, if any. */
export async function findActiveTaskForAgent(
  session: RuntimeSession,
  agentId: string,
  parentTurnId?: string,
  parentStepIndex?: number,
): Promise<{ readonly entry: SessionTaskIndexEntry; readonly view: TaskView } | undefined> {
  const entries = getSessionTaskIndex(session.state).filter(
    (entry) => entry.metadata.agentId === agentId,
  );
  const views = await readTaskViews(entries);
  const active = entries.flatMap((entry, index) => {
    const view = views[index];
    return view !== undefined &&
      ((entry.createdByTurnId === parentTurnId && entry.createdByStepIndex === parentStepIndex) ||
        view.status === "working" ||
        view.status === "input_required")
      ? [{ entry, view }]
      : [];
  });
  return active[0];
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
