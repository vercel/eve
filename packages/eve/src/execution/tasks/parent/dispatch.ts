import type { HarnessSession as RuntimeSession } from "#harness/types.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  lookupTaskEntries,
  readTaskView,
} from "#execution/tasks/parent/control-shared.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { wakeTaskParentStep } from "#execution/tasks/child/steps.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  cancelTaskOwnedWork,
  type TaskExecutorCancel,
} from "#execution/tasks/parent/task-cancel.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskView } from "#tasks/types.js";
import { TASK_CANCEL_TOOL_NAME, TASK_TOOL_NAMES } from "#tools/framework/task-contract.js";

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

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
  readonly pendingTask?: BackgroundTask;
}> {
  const { action, session } = input;
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
    views.push(
      await cancelOwnedTask({
        cancelOwnedWork: input.cancelOwnedWork,
        entry,
        serializedContext: input.serializedContext,
        session,
      }),
    );
  }
  return { result: createTaskViewsResult(action, views), session };
}

/** Commits cancellation, then stops task-owned child work and its lifecycle run. */
export async function cancelOwnedTask(input: {
  readonly cancelOwnedWork?: TaskExecutorCancel;
  readonly entry: SessionTaskIndexEntry;
  readonly serializedContext?: Record<string, unknown>;
  readonly session?: RuntimeSession;
}): Promise<TaskView> {
  const delivery = await sendTaskCommand({
    command: { kind: "cancel" },
    taskInboxToken: input.entry.taskInboxToken,
  });
  let view = await readTaskView(input.entry);
  for (
    let attempt = 0;
    attempt < CANCEL_COMMIT_POLL_ATTEMPTS && !isTerminalTaskStatus(view.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_COMMIT_POLL_DELAY_MS));
    view = await readTaskView(input.entry);
  }
  if (!isTerminalTaskStatus(view.status)) {
    throw new Error(`Task "${input.entry.taskId}" did not commit cancellation before timeout.`);
  }
  if (view.status !== "cancelled") return view;

  // The task inbox may be closed after an earlier cancellation committed but
  // failed to stop its child. Retrying must still finish that cancellation.
  const forcedShutdown = await cancelTaskOwnedWork({
    cancelOwnedWork: input.cancelOwnedWork,
    entry: input.entry,
    serializedContext: input.serializedContext,
    session: input.session,
  });
  if ((delivery === "unreachable" || forcedShutdown) && input.session !== undefined) {
    // Forced shutdown can interrupt the lifecycle between its committed view
    // and parent wake. Retried cancellation must finish delivery even when the
    // inbox is gone; the shared delivery id deduplicates a wake already sent.
    await wakeTaskParentStep({
      token: sessionCommandHookToken(input.session.sessionId),
      view,
    });
  }
  return view;
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
