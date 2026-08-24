import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { deserializeContext } from "#context/serialize.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
  resolveRemoteAgentStreamHeaders,
} from "#execution/remote-agent-dispatch.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  findTaskAgentAddress,
  lookupTaskEntries,
  readTaskView,
} from "#execution/tasks/parent/control-shared.js";
import { executeTaskUpdate } from "#execution/tasks/child/update.js";
import { readWorkflowToolExecutor } from "#execution/tool-run/background.js";
import { cancelToolRun } from "#execution/tool-run/cancel.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { DelegatedTask } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolCallActionRequest,
} from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_TOOL_NAMES,
  TASK_UPDATE_TOOL_NAME,
} from "#tools/framework/task-contract.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import {
  isTerminalTaskStatus,
  readSubagentExecutor,
  readSubagentTaskMetadata,
  type SubagentExecutorData,
  type TaskView,
} from "#tasks/types.js";

const log = createLogger("execution.tasks.dispatch");

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

/** True for task-control calls dispatched outside the model loop. */
export function isTaskControlAction(
  action: RuntimeActionRequest,
): action is RuntimeToolCallActionRequest {
  return action.kind === "tool-call" && TASK_TOOL_NAMES.has(action.toolName);
}

/**
 * Executes one task-control call inside the dispatch step, which holds
 * the durable session state (ownership index) and world access the
 * tools need.
 *
 * Returns the current session alongside the action result.
 */
export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly adapter?: ChannelAdapter;
  readonly bundle: CompiledBundle;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly serializedContext?: Record<string, unknown>;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult;
  readonly session: RuntimeSession;
  readonly pendingTask?: DelegatedTask;
}> {
  const { action, session } = input;

  if (action.toolName === TASK_UPDATE_TOOL_NAME) {
    return {
      result: await executeTaskUpdate({
        action,
        adapter: input.adapter,
        updateIndex: input.parentStepIndex ?? 0,
        updateEpoch: input.parentTurnId,
        serializedContext: input.serializedContext,
      }),
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
  const entries = lookup.entries;

  if (action.toolName !== TASK_CANCEL_TOOL_NAME) {
    return {
      result: createTaskControlError(action, `Unsupported task control "${action.toolName}".`),
      session,
    };
  }

  const views: TaskView[] = [];
  for (const entry of entries) {
    views.push(
      await cancelOwnedTask({
        bundle: input.bundle,
        entry,
        serializedContext: input.serializedContext,
        session,
      }),
    );
  }
  return { result: createTaskViewsResult(action, views), session };
}

/** Commits task cancellation, then propagates it to the addressed executor. */
export async function cancelOwnedTask(input: {
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly serializedContext?: Record<string, unknown>;
  readonly session: RuntimeSession;
}): Promise<TaskView> {
  const { entry } = input;
  const delivery = await sendTaskCommand({
    command: { kind: "cancel" },
    taskInboxToken: entry.taskInboxToken,
  });

  // The `cancelled` state must commit before the executor abort
  // propagates, so a late child result can never revive the task.
  let view = await readTaskView(entry);
  for (
    let attempt = 0;
    attempt < CANCEL_COMMIT_POLL_ATTEMPTS && !isTerminalTaskStatus(view.status);
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
    await propagateTaskCancel({
      bundle: input.bundle,
      serializedContext: input.serializedContext,
      entry,
      session: input.session,
      view: settledView,
    });
  }
  return settledView;
}

/**
 * Best-effort cooperative abort of the cancelled task's child turn. The
 * child address comes from the task's durable executor binding when one
 * was written at delegation, falling back to the agent handle in session
 * state for tasks delegated before an executor binding existed. A task
 * with neither has nothing left to abort.
 */
async function propagateTaskCancel(input: {
  readonly bundle: CompiledBundle;
  readonly serializedContext?: Record<string, unknown>;
  readonly entry: SessionTaskIndexEntry;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<void> {
  const toolRun = readWorkflowToolExecutor(input.view.executor?.binding);
  if (toolRun !== undefined) {
    // The run cannot report its own end once cancelled, so settle the
    // executor here; that is what lets the task run finish and release
    // its hook.
    await cancelToolRun({
      callId: input.entry.taskId,
      hookToken: toolRun.hookToken,
      reason: `Task ${input.entry.taskId} was cancelled.`,
      runId: toolRun.runId,
      toolName: input.entry.metadata.name,
    });
    await sendTaskCommand({
      command: { kind: "settle-executor" },
      taskInboxToken: input.entry.taskInboxToken,
    });
    return;
  }

  const metadata = readSubagentTaskMetadata(input.view);
  if (metadata === undefined) return;
  const executor =
    readSubagentExecutor(input.view.executor) ??
    findTaskAgentAddress(input.session, metadata.agentId);
  if (executor === undefined) return;
  if (
    input.view.executor?.childSessionId !== undefined &&
    input.view.executor.childSessionId !== executor.address.sessionId
  ) {
    return;
  }
  await propagateSubagentExecutorCancel({
    bundle: input.bundle,
    childTurnId: input.view.executor?.childTurnId,
    executor,
    serializedContext: input.serializedContext,
    taskId: input.view.taskId,
  });
}

/**
 * Sends the cooperative abort to the child identified by a subagent
 * executor binding. Failures are logged, never thrown: the task is already
 * terminal when this runs, so the worst outcome is a child that runs to
 * completion and has its callback refused.
 */
export async function propagateSubagentExecutorCancel(input: {
  readonly bundle: CompiledBundle | undefined;
  readonly childTurnId?: string;
  readonly executor: SubagentExecutorData;
  readonly serializedContext?: Record<string, unknown>;
  readonly taskId: string;
}): Promise<void> {
  const { address, identity } = input.executor;
  const childSessionId = address.sessionId;
  const childTurnId = input.childTurnId;

  try {
    if (address.kind === "agent/remote") {
      if (input.bundle === undefined) {
        throw new Error("No compiled bundle is available to resolve the remote agent.");
      }
      const credentialResolver = address.credentialResolver;
      let dynamicRemoteAgent;
      if (credentialResolver === undefined && input.serializedContext !== undefined) {
        const ctx = await deserializeContext(input.serializedContext);
        const selection = getDynamicSubagentSelection(ctx, identity.nodeId);
        dynamicRemoteAgent = selection?.kind === "remote" ? selection.remoteAgent : undefined;
      }
      const resolved =
        credentialResolver === undefined
          ? resolveRemoteAgentForAction({
              dynamicRemoteAgent,
              nodeId: identity.nodeId,
              remoteAgentName: identity.name,
              registry: input.bundle.subagentRegistry.subagentsByNodeId,
            })
          : { name: identity.name, url: address.url };
      const legacyUrlMismatch = credentialResolver === undefined && resolved.url !== address.url;
      const headers = legacyUrlMismatch
        ? {}
        : credentialResolver?.resolverId === undefined
          ? credentialResolver === undefined
            ? undefined
            : {}
          : await resolveRemoteAgentStreamHeaders({
              bundle: input.bundle,
              name: identity.name,
              resolverId: credentialResolver.resolverId,
              url: address.url,
            });
      const remote = legacyUrlMismatch
        ? { name: identity.name, url: address.url }
        : { ...resolved, url: address.url };
      const cancelInput: {
        headers?: Record<string, string>;
        readonly remote: typeof resolved & { readonly url: string };
        readonly sessionId: string;
        readonly taskId: string;
        turnId?: string;
      } = {
        remote,
        sessionId: childSessionId,
        taskId: input.taskId,
      };
      if (headers !== undefined) cancelInput.headers = headers;
      if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
      const result = await cancelRemoteAgentTurn(cancelInput);
      if (result.status === "no_active_turn") {
        const retryInput: {
          headers?: Record<string, string>;
          remote: typeof resolved & { readonly url: string };
          sessionId: string;
          taskId: string;
        } = {
          remote,
          sessionId: childSessionId,
          taskId: input.taskId,
        };
        if (headers !== undefined) retryInput.headers = headers;
        await cancelRemoteAgentTurn(retryInput);
      }
      return;
    }
    const cancelInput: {
      readonly sessionId: string;
      readonly taskId: string;
      turnId?: string;
    } = {
      sessionId: childSessionId,
      taskId: input.taskId,
    };
    if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
    const result = await requestWorkflowTurnCancellation(cancelInput);
    if (result.status === "no_active_turn") {
      await requestWorkflowTurnCancellation({
        sessionId: childSessionId,
        taskId: input.taskId,
      });
    }
  } catch (error) {
    logError(log, "task cancel propagation failed; the child may run to completion", error, {
      childSessionId,
      taskId: input.taskId,
    });
  }
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
