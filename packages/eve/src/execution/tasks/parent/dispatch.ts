import type { ChannelAdapter } from "#channel/adapter.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
} from "#execution/subagent-adapter-state.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  lookupTaskEntries,
  readTaskView,
} from "#execution/tasks/parent/control-shared.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import {
  cancelTaskOwnedWork,
  type TaskExecutorCancel,
} from "#execution/tasks/parent/task-cancel.js";
import { fireTaskUpdateCallbackStep } from "#execution/session-callback-step.js";
import { forwardLocalTaskUpdateStep } from "#execution/task-update-proxy-step.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskInboundUpdate, type TaskView } from "#tasks/types.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_TOOL_NAMES,
  TASK_UPDATE_TOOL_NAME,
} from "#tools/framework/task-contract.js";

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

export function isTaskControlAction(action: RuntimeToolCallActionRequest): boolean {
  return action.kind === "tool-call" && TASK_TOOL_NAMES.has(action.toolName);
}

export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly adapter?: ChannelAdapter;
  readonly bundle: import("#runtime/sessions/runtime-context-keys.js").CompiledBundle;
  readonly cancelOwnedWork?: TaskExecutorCancel;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly serializedContext?: Record<string, unknown>;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult;
  readonly session: RuntimeSession;
  readonly pendingTask?: BackgroundTask;
}> {
  const { action, session } = input;
  if (action.toolName === TASK_UPDATE_TOOL_NAME) {
    const message = action.input.message;
    if (typeof message !== "string" || message.trim() === "") {
      return {
        result: createTaskControlError(action, "Provide a non-empty `message`."),
        session,
      };
    }
    const update = {
      callId: action.callId,
      kind: "task-update",
      message,
      updateEpoch: input.parentTurnId,
      updateIndex: input.parentStepIndex ?? 0,
    } satisfies TaskInboundUpdate;
    const taskId = await deliverTaskUpdate({
      adapter: input.adapter,
      callback: input.serializedContext?.["eve.sessionCallback"],
      update,
    });
    return {
      result:
        taskId === undefined
          ? createTaskControlError(action, "task_update requires a task-owned session.")
          : {
              callId: action.callId,
              kind: "tool-result",
              output: { status: "sent", taskId },
              toolName: action.toolName,
            },
      session,
    };
  }
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

async function deliverTaskUpdate(input: {
  readonly adapter?: ChannelAdapter;
  readonly callback: unknown;
  readonly update: TaskInboundUpdate;
}): Promise<string | undefined> {
  const local = readLocalTaskUpdateRoute(input.adapter);
  if (local !== undefined) {
    await forwardLocalTaskUpdateStep({
      parentContinuationToken: local.parentContinuationToken,
      update: input.update,
    });
    return local.taskId;
  }
  return await fireTaskUpdateCallbackStep({
    callback: input.callback,
    callId: input.update.callId,
    message: input.update.message,
    updateEpoch: input.update.updateEpoch,
    updateIndex: input.update.updateIndex,
  });
}

function readLocalTaskUpdateRoute(
  adapter: ChannelAdapter | undefined,
): { readonly parentContinuationToken: string; readonly taskId: string } | undefined {
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }
  if (adapter.state.taskId === undefined) return undefined;
  return {
    parentContinuationToken: adapter.state.parentContinuationToken,
    taskId: adapter.state.taskId,
  };
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
  if (view.status !== "cancelled" || delivery !== "delivered") return view;

  await cancelTaskOwnedWork({
    cancelOwnedWork: input.cancelOwnedWork,
    entry: input.entry,
    serializedContext: input.serializedContext,
    session: input.session,
  });
  return view;
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
