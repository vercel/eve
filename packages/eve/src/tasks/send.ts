import type { SessionAuthContext } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import type { WorkflowToolRunSendCall } from "#execution/tools/workflow/messages.js";
import type { SessionStateMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { taskStartedEvent } from "#tasks/events.js";
import { checkSend, retireIdleTasks } from "#tasks/owner-calls.js";
import { isTerminalTaskStatus, type TaskCommand } from "#tasks/protocol.js";
import { sendReceiptResult, taskToolErrorResult } from "#tasks/receipts.js";
import { renderUnknownSendTask } from "#tasks/render.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { TASK_CANCEL_CONFIRM_MS, type TaskTable } from "#tasks/table.js";
import { sendTask, withdrawSend } from "#tasks/table-generations.js";
import { armChildHardStop } from "#tasks/timer-steps.js";
import {
  RETIRED_IDLE_TASK_REASON,
  retireIdleTask,
  runCommands,
  sendTaskInput,
  type CommandEffect,
  type SendFailure,
} from "#tasks/transport.js";

// The owner's sends, a call to a resumable tool with a task's `taskId`, and
// the retirement of idle tasks past the cap.

const log = createLogger("tasks.send");

type Session = { readonly sessionId: string; readonly state?: SessionStateMap };

/**
 * Delivers the input commands of a send to its task's child. Returns the
 * call's error when the child did not take the input; the owner then keeps
 * no record of the send.
 */
export async function deliverSends(input: {
  readonly callbackAlias: string | undefined;
  /** A workflow run's generation takes the send's call context. */
  readonly call?: WorkflowToolRunSendCall;
  readonly ctx: ContextContainer | undefined;
  readonly effects: readonly CommandEffect[];
  readonly ownerSessionId: string;
}): Promise<SendFailure | undefined> {
  for (const effect of input.effects) {
    for (const command of effect.commands) {
      if (command.kind !== "input") continue;
      const failure = await sendTaskInput({ ...input, command, record: effect.record });
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}

/**
 * Applies a send to a resumable workflow tool's task, from a model call with
 * `taskId`. The input goes to the run's command hook at once; the call
 * returns its receipt, or the send's error, such as `UNKNOWN_TASK`.
 */
export async function applyWorkflowSend<T extends Session>(input: {
  readonly call: WorkflowToolRunSendCall;
  readonly caller: SessionAuthContext | null;
  readonly ctx: ContextContainer | undefined;
  readonly now: string;
  readonly request: RuntimeWorkflowTaskRequest & { readonly taskId: string };
  readonly session: T;
}): Promise<{
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly result: RuntimeToolResultActionResult;
  readonly session: T;
}> {
  const { request, session } = input;
  const table = getTaskTable(session);
  const refused = checkSend({
    caller: input.caller,
    table,
    taskId: request.taskId,
    toolName: request.toolName,
  });
  const sent =
    refused === undefined
      ? sendTask(table, {
          callId: request.callId,
          input: request.input,
          now: input.now,
          taskId: request.taskId,
          turnId: input.call.turn.id,
        })
      : undefined;
  const error = refused ?? {
    code: "UNKNOWN_TASK",
    message: renderUnknownSendTask(request.taskId, request.toolName),
  };
  if (sent === undefined)
    return { events: [], result: taskToolErrorResult(request, error), session };
  const receipt = (started: boolean) =>
    sendReceiptResult({
      callId: request.callId,
      record: sent.record,
      started,
      toolName: request.toolName,
    });
  if (sent.kind === "existing") {
    return { events: [], result: receipt(sent.record.callId === request.callId), session };
  }
  const failure = await deliverSends({
    call: input.call,
    callbackAlias: undefined,
    ctx: input.ctx,
    effects: sent.effects.filter((effect) => effect.kind === "send"),
    ownerSessionId: session.sessionId,
  });
  if (failure !== undefined) {
    return {
      events: [],
      result: {
        callId: request.callId,
        isError: true,
        kind: "tool-result",
        output: failure.output,
        toolName: request.toolName,
      },
      session,
    };
  }
  const child = sent.record.child;
  return {
    events:
      sent.started && child !== undefined
        ? [taskStartedEvent({ child, ownerSessionId: session.sessionId, record: sent.record })]
        : [],
    result: receipt(sent.started),
    session: setTaskTable(session, sent.table),
  };
}

/**
 * Runs the commands held for a child that just reported `task.started`. A
 * held send that cannot be delivered then is dropped and logged, and no
 * generation waits for it; the call that sent it already returned its
 * receipt. A stopped task's held sends are not sent.
 */
export async function flushHeldCommands(input: {
  readonly callbackAlias: string | undefined;
  readonly ctx: ContextContainer | undefined;
  readonly effects: readonly CommandEffect[];
  readonly ownerSessionId: string;
  readonly table: TaskTable;
}): Promise<TaskTable> {
  let table = input.table;
  const others: CommandEffect[] = [];
  for (const effect of input.effects) {
    const rest = effect.commands.filter((command) => command.kind !== "input");
    if (rest.length > 0) others.push({ ...effect, commands: rest });
    if (isTerminalTaskStatus(effect.record.status)) continue;
    for (const command of effect.commands) {
      if (command.kind !== "input") continue;
      const failure = await sendTaskInput({
        ...input,
        command: command as Extract<TaskCommand, { readonly kind: "input" }>,
        record: effect.record,
      });
      if (failure === undefined) continue;
      log.error("a held send did not reach its task; its result will not reflect it", {
        taskId: effect.record.id,
      });
      table = withdrawSend(table, effect.record.id, command.seq);
    }
  }
  await runCommands(others, input.ctx);
  return table;
}

/**
 * Ends the idle tasks past the cap after the owner started tasks: new tasks
 * are the only way idle ones accumulate. The retired records are gone, so no
 * later deadline or session end can stop their children; a local agent the
 * request did not reach gets a hard-stop timer of its own.
 */
export async function retireIdleTaskChildren<T extends Session>(input: {
  readonly caller: SessionAuthContext | null;
  readonly ctx: ContextContainer | undefined;
  readonly now: string;
  readonly session: T;
}): Promise<T> {
  const retired = retireIdleTasks(getTaskTable(input.session), input.caller);
  if (retired.retired.length === 0) return input.session;
  const session = setTaskTable(input.session, retired.table);
  const unreached = (
    await Promise.all(retired.retired.map((record) => retireIdleTask(record, input.ctx)))
  ).filter((child) => child !== undefined);
  if (unreached.length === 0) return session;
  try {
    await armChildHardStop({
      endReason: RETIRED_IDLE_TASK_REASON,
      ownerSessionId: session.sessionId,
      targets: unreached,
      wakeAt: new Date(Date.parse(input.now) + TASK_CANCEL_CONFIRM_MS).toISOString(),
    });
  } catch (error) {
    logError(log, "failed to arm the hard stop for retired idle tasks", error, {
      ownerSessionId: session.sessionId,
    });
  }
  return session;
}
