import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  findTaskAgentAddress,
  lookupTaskEntries,
  readTaskViews,
  readTaskView,
} from "#execution/tasks/control-shared.js";
import { executeTaskSend } from "#execution/tasks/send.js";
import type { DelegatedTask } from "#execution/tasks/delegate.js";
import { sendTaskCommand } from "#execution/tasks/run-control.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolCallActionRequest,
} from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_CONTROL_TOOL_NAMES,
  TASK_PEEK_TOOL_NAME,
  TASK_SEND_TOOL_NAME,
} from "#runtime/framework-tools/tasks.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskView } from "#tasks/types.js";

export {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/delegate.js";

const log = createLogger("execution.tasks.dispatch");

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

/** True for `task_peek` / `task_cancel` / `task_send` calls. */
export function isTaskControlAction(
  action: RuntimeActionRequest,
): action is RuntimeToolCallActionRequest {
  return action.kind === "tool-call" && TASK_CONTROL_TOOL_NAMES.has(action.toolName);
}

/**
 * Executes one task-control call inside the dispatch step, which holds
 * the durable session state (ownership index) and world access the
 * tools need.
 *
 * Returns the (possibly updated) session: `task_send` follow-ups record
 * new tasks and settle the continued agent handle.
 */
export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult | undefined;
  readonly session: RuntimeSession;
  readonly taskReadiness?: DelegatedTask;
}> {
  const { action, session } = input;

  if (action.toolName === TASK_SEND_TOOL_NAME) {
    return executeTaskSend(input);
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
  const entries = lookup.entries;

  switch (action.toolName) {
    case TASK_PEEK_TOOL_NAME: {
      const views = await readTaskViews(entries);
      return { result: createTaskViewsResult(action, views), session };
    }
    case TASK_CANCEL_TOOL_NAME: {
      const views: TaskView[] = [];
      for (const entry of entries) {
        views.push(await cancelOwnedTask({ bundle: input.bundle, entry, session }));
      }
      return { result: createTaskViewsResult(action, views), session };
    }
    default:
      return {
        result: createTaskControlError(action, `Unsupported task control "${action.toolName}".`),
        session,
      };
  }
}

/** Commits task cancellation, then propagates it to the addressed executor. */
export async function cancelOwnedTask(input: {
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly session: RuntimeSession;
}): Promise<TaskView> {
  const { entry } = input;
  const delivery = await sendTaskCommand({
    command: { kind: "cancel" },
    commandToken: entry.commandToken,
  });

  // The `cancelled` state must commit before the executor abort
  // propagates, so a late child result can never revive the task.
  let view = await readTaskView(entry);
  for (
    let attempt = 0;
    attempt < CANCEL_COMMIT_POLL_ATTEMPTS &&
    !(view !== undefined && isTerminalTaskStatus(view.status));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_COMMIT_POLL_DELAY_MS));
    view = await readTaskView(entry);
  }
  if (!isTerminalTaskStatus(view.status)) {
    throw new Error(`Task "${entry.taskId}" did not commit cancellation before timeout.`);
  }
  const settledView = view;

  if (settledView.status === "cancelled" && delivery === "delivered") {
    await propagateTaskCancel({ bundle: input.bundle, session: input.session, view: settledView });
  }
  return settledView;
}

/**
 * Best-effort cooperative abort of the cancelled task's child turn,
 * routed through the agent handle that owns the child address. A task
 * whose handle is already gone has nothing left to abort.
 */
async function propagateTaskCancel(input: {
  readonly bundle: CompiledBundle;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<void> {
  const handle = findTaskAgentAddress(input.session, input.view.metadata.agentId);
  if (handle === undefined) return;
  const childSessionId = handle.address.sessionId;
  const childTurnId = input.view.executor?.childTurnId;
  if (
    input.view.executor?.childSessionId !== undefined &&
    input.view.executor.childSessionId !== childSessionId
  ) {
    return;
  }

  try {
    if (handle !== undefined && handle.address.kind === "agent/remote") {
      const resolved = resolveRemoteAgentForAction({
        nodeId: handle.identity.nodeId,
        remoteAgentName: handle.identity.name,
        registry: input.bundle.subagentRegistry.subagentsByNodeId,
      });
      const cancelInput: {
        readonly remote: typeof resolved & { readonly url: string };
        readonly sessionId: string;
        readonly taskId: string;
        turnId?: string;
      } = {
        remote: { ...resolved, url: handle.address.url },
        sessionId: childSessionId,
        taskId: input.view.taskId,
      };
      if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
      const result = await cancelRemoteAgentTurn(cancelInput);
      if (result.status === "no_active_turn") {
        await cancelRemoteAgentTurn({
          remote: { ...resolved, url: handle.address.url },
          sessionId: childSessionId,
          taskId: input.view.taskId,
        });
      }
      return;
    }
    const cancelInput: {
      readonly sessionId: string;
      readonly taskId: string;
      turnId?: string;
    } = {
      sessionId: childSessionId,
      taskId: input.view.taskId,
    };
    if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
    const result = await requestWorkflowTurnCancellation(cancelInput);
    if (result.status === "no_active_turn") {
      await requestWorkflowTurnCancellation({
        sessionId: childSessionId,
        taskId: input.view.taskId,
      });
    }
  } catch (error) {
    logError(log, "task cancel propagation failed; the child may run to completion", error, {
      childSessionId,
      taskId: input.view.taskId,
    });
  }
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
