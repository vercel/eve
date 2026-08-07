import {
  dispatchToTaskAgentAddress,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  createPendingTaskView,
  createTaskControlError,
  createUnknownTasksError,
  findActiveTaskForAgent,
  findTaskAgentAddress,
} from "#execution/tasks/control-shared.js";
import {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
} from "#execution/tasks/delegate.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { AGENT_BUSY, AGENT_UNREACHABLE } from "#harness/agent-handle-errors.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";

/**
 * Routes one `task_send`:
 *
 * - `working` tasks are busy — the send surfaces `AGENT_BUSY` instead
 *   of queueing (settled decision; queueing is the reversible follow-up);
 * - `input_required` tasks reject model-authored sends; clients answer
 *   them through the parent channel's direct HITL route;
 * - terminal tasks accept a `message` follow-up, which starts a new
 *   task bound to the same child session and returns its receipt.
 */
export async function executeTaskSend(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult | undefined;
  readonly session: RuntimeSession;
}> {
  const { action, session } = input;
  const send = readTaskSendInput(action.input);
  if (send.kind === "invalid") {
    return { result: createTaskControlError(action, send.message), session };
  }

  const entry = findSessionTaskEntry(session.state, send.taskId);
  if (entry === undefined) {
    return { result: createUnknownTasksError(action, [send.taskId]), session };
  }

  const view =
    (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ?? createPendingTaskView(entry);

  if (view.status === "working") {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_BUSY}: task "${view.taskId}" is still working. Let it finish, or cancel it first.`,
      ),
      session,
    };
  }

  if (view.status === "input_required") {
    return {
      result: createTaskControlError(
        action,
        `Task "${view.taskId}" is waiting on input; the human must answer through the parent channel.`,
      ),
      session,
    };
  }

  return followUpTerminalTask({
    action,
    bundle: input.bundle,
    message: send.message,
    parentStepIndex: input.parentStepIndex,
    parentTurnId: input.parentTurnId,
    session,
    view,
  });
}

async function followUpTerminalTask(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly message: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<{ readonly result: RuntimeActionResult; readonly session: RuntimeSession }> {
  const { action, view } = input;
  const active = await findActiveTaskForAgent(
    input.session,
    view.metadata.agentId,
    input.parentTurnId,
    input.parentStepIndex,
  );
  if (active !== undefined) {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_BUSY}: agent "${view.metadata.agentId}" is busy with task "${active.view.taskId}" (${active.view.status}).`,
      ),
      session: input.session,
    };
  }
  const handle = findTaskAgentAddress(input.session, view.metadata.agentId);
  if (handle === undefined) {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_UNREACHABLE}: task "${view.taskId}"'s agent is no longer addressable.`,
      ),
      session: input.session,
    };
  }
  const continuation: RuntimeAgentHandleAction =
    handle.address.kind === "agent/remote"
      ? {
          callId: action.callId,
          description: "",
          input: { message: input.message },
          kind: "remote-agent-call",
          name: handle.identity.name,
          nodeId: handle.identity.nodeId,
          remoteAgentName: handle.identity.name,
        }
      : {
          callId: action.callId,
          description: "",
          input: { message: input.message },
          kind: "subagent-call",
          name: handle.identity.name,
          nodeId: handle.identity.nodeId,
          subagentName: handle.identity.name,
        };

  const task = await beginDelegatedTask({
    agentId: handle.identity.id,
    callId: action.callId,
    mode: handle.address.kind === "agent/remote" ? "remote" : "local",
    name: handle.identity.name,
    parentSessionId: input.session.sessionId,
    parentStepIndex: input.parentStepIndex,
    parentTurnId: input.parentTurnId,
    session: input.session,
  });
  // Reserve the addressed agent before the ambiguous delivery side effect.
  const reserved = await settleDelegatedDispatch({
    callId: action.callId,
    session: input.session,
    subagentName: handle.identity.name,
    task,
  });
  const outcome = await dispatchToTaskAgentAddress({
    action: continuation,
    agentId: handle.identity.id,
    bundle: input.bundle,
    currentSession: reserved.session,
    parentToken: task.commandToken,
  });
  if (outcome.kind === "error") {
    if (findTaskAgentAddress(outcome.session, handle.identity.id) === undefined) {
      await failDelegatedDispatch({ error: outcome.result.output, task });
    }
    return {
      result: {
        callId: action.callId,
        isError: true,
        kind: "tool-result",
        output: { error: outcome.result.output, taskId: task.taskId },
        toolName: action.toolName,
      },
      session: outcome.session,
    };
  }

  return {
    result: {
      callId: action.callId,
      kind: "tool-result",
      output: { agentId: task.metadata.agentId, status: "working", taskId: task.taskId },
      toolName: action.toolName,
    },
    session: outcome.session,
  };
}

type TaskSendInput =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "send"; readonly message: string; readonly taskId: string };

function readTaskSendInput(input: Record<string, unknown>): TaskSendInput {
  const taskId =
    typeof input.taskId === "string" && input.taskId.trim() !== "" ? input.taskId : undefined;
  if (taskId === undefined) {
    return { kind: "invalid", message: "Provide the `taskId` from a task receipt." };
  }
  const message =
    typeof input.message === "string" && input.message.trim() !== "" ? input.message : undefined;
  if (message !== undefined) {
    return { kind: "send", message, taskId };
  }
  return { kind: "invalid", message: "Provide a non-empty `message`." };
}
