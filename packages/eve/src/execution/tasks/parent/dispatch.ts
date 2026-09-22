import type { HarnessSession as RuntimeSession } from "#harness/types.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  lookupTaskEntries,
} from "#execution/tasks/parent/control-shared.js";
import {
  recordWorkflowTaskView,
  readWorkflowTaskView,
  type BackgroundWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { notifyTaskParent } from "#execution/tasks/child/notify.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import {
  cancelTaskOwnedWork,
  type TaskExecutorCancel,
} from "#execution/tasks/parent/task-cancel.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { type TaskView } from "#tasks/types.js";
import { TASK_CANCEL_TOOL_NAME, TASK_TOOL_NAMES } from "#tools/framework/task-contract.js";

export function isTaskControlAction(action: RuntimeToolCallActionRequest): boolean {
  return action.kind === "tool-call" && TASK_TOOL_NAMES.has(action.toolName);
}

export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly cancelOwnedWork?: TaskExecutorCancel;
  readonly serializedContext?: Record<string, unknown>;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult;
  readonly session: RuntimeSession;
}> {
  const { action } = input;
  let session = input.session;
  const taskIds = readTaskIds(action.input);
  if (taskIds === undefined || taskIds.length === 0) {
    return {
      result: createTaskControlError(action, "Provide a non-empty `taskIds` array."),
      session,
    };
  }
  const lookup = lookupTaskEntries(session, taskIds);
  if (lookup.kind === "unknown") {
    return { result: createUnknownTasksError(action, lookup.unknown), session };
  }
  if (action.toolName !== TASK_CANCEL_TOOL_NAME) {
    return {
      result: createTaskControlError(action, `Unsupported task control "${action.toolName}".`),
      session,
    };
  }

  const views: TaskView[] = [];
  for (const entry of lookup.entries) {
    const view = await cancelOwnedTask({
      cancelOwnedWork: input.cancelOwnedWork,
      entry,
      serializedContext: input.serializedContext,
      session,
    });
    session = { ...session, state: recordWorkflowTaskView(session.state, view) };
    views.push(view);
  }
  return { result: createTaskViewsResult(action, views), session };
}

/** Cancels task-owned work; the caller records the outcome in the parent session. */
export async function cancelOwnedTask(input: {
  readonly cancelOwnedWork?: TaskExecutorCancel;
  readonly entry: BackgroundWorkflowToolRun;
  readonly serializedContext?: Record<string, unknown>;
  readonly session?: RuntimeSession;
}): Promise<TaskView> {
  const previous = readWorkflowTaskView(input.entry.task);
  if (previous !== undefined && previous.status !== "cancelled") return previous;
  const view: TaskView = previous ?? {
    metadata: input.entry.task.metadata,
    status: "cancelled",
    taskId: input.entry.task.taskId,
  };
  await sendTaskCommand({
    command: { kind: "cancel" },
    taskInboxToken: input.entry.address.hookToken,
  });
  // The task inbox may be closed after an earlier cancellation committed but
  // failed to stop its child. Retrying must still finish that cancellation.
  await cancelTaskOwnedWork({
    cancelOwnedWork: input.cancelOwnedWork,
    entry: input.entry,
    serializedContext: input.serializedContext,
    session: input.session,
  });
  if (input.session !== undefined) {
    // Queue settlement even when the child cannot report. The parent records
    // this control result before routing queued notifications; late outcomes lose.
    await notifyTaskParent({
      token: sessionCommandHookToken(input.session.sessionId),
      view,
    });
  }
  return view;
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = decodeJsonString(input.taskIds);
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}

function decodeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
