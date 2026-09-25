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
import { taskEvents } from "#tasks/events.js";
import { checkSend, retireIdleTasks, unknownSend } from "#tasks/owner-calls.js";
import { isTerminalTaskStatus, type TaskCommand } from "#tasks/protocol.js";
import { sendReceiptResult, taskToolErrorResult } from "#tasks/receipts.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { findTask, TASK_CANCEL_CONFIRM_MS, type TaskTable } from "#tasks/table.js";
import {
  announceDeliveredGeneration,
  endTask,
  markSendUnconfirmed,
  sendTask,
  withdrawSend,
  type SentTask,
} from "#tasks/table-generations.js";
import { armChildHardStop } from "#tasks/timer-steps.js";
import {
  RETIRED_IDLE_TASK_REASON,
  retireIdleTask,
  runCommands,
  sendTaskInput,
  type CommandEffect,
  type SendFailure,
} from "#tasks/transport.js";
import { routeSettledResults } from "#tasks/wait.js";

// The owner's sends, a call to a resumable tool with a task's `taskId`, and
// the retirement of idle tasks past the cap.

const log = createLogger("tasks.send");

type Session = { readonly sessionId: string; readonly state?: SessionStateMap };

type InputCommand = Extract<TaskCommand, { readonly kind: "input" }>;

/** What the owner publishes and returns after a transition it applied for a call. */
interface OwnerChange<T> {
  readonly events: readonly UnstampedMessageStreamEvent[];
  /** Results of live `task_wait` calls the transition settled. */
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly session: T;
}

/**
 * Delivers a recorded send's input to its task's child, when the child is
 * started and takes input now, and writes the table after it. A send the
 * child did not take is withdrawn (see `withdrawSend`), and a child gone for
 * good ends its task, failing the work it held. A send an agent may have
 * taken after all stays queued, `unconfirmed` (see `markSendUnconfirmed`).
 */
export async function deliverSend<T extends Session>(input: {
  readonly callbackAlias: string | undefined;
  /** A workflow run's generation takes the send's call context. */
  readonly call?: WorkflowToolRunSendCall;
  readonly ctx: ContextContainer | undefined;
  readonly now: string;
  readonly sent: SentTask;
  /** The session before the send. */
  readonly session: T;
}): Promise<OwnerChange<T> & { readonly failure?: SendFailure; readonly unconfirmed?: true }> {
  const { sent, session } = input;
  const command = sent.effects.flatMap((effect) =>
    effect.kind === "send" ? effect.commands.filter(isInputCommand) : [],
  )[0];
  const failure =
    command === undefined
      ? undefined
      : await sendTaskInput({
          ...input,
          command,
          ownerSessionId: session.sessionId,
          record: sent.record,
        });
  if (failure === undefined) {
    return { events: [], results: [], session: setTaskTable(session, sent.table) };
  }
  if (failure.unconfirmed === true) {
    const table = markSendUnconfirmed(sent.table, sent.record.id, sent.send);
    return { events: [], results: [], session: setTaskTable(session, table), unconfirmed: true };
  }
  return { ...withdrawFailedSend(session, sent, failure, input.now), failure };
}

/**
 * Applies the delivery of an idle agent's next turn, which `sendTask`
 * started unannounced: the generation is announced once the agent took the
 * turn. A turn it did not take is withdrawn like any failed send, even one
 * it may have taken: its answer then names a call the task no longer waits
 * on, and is dropped.
 */
export function applyIdleAgentDelivery<T extends Session>(input: {
  readonly failure: SendFailure | undefined;
  readonly now: string;
  readonly sent: SentTask;
  /** The session before the send. */
  readonly session: T;
}): OwnerChange<T> {
  const { failure, sent, session } = input;
  if (failure !== undefined) return withdrawFailedSend(session, sent, failure, input.now);
  const announced = announceDeliveredGeneration(sent.table, sent.record.id);
  return {
    events: taskEvents(announced.effects, session.sessionId),
    results: [],
    session: setTaskTable(session, announced.table),
  };
}

/** Takes back a send its child did not take, ending the task when the child is gone for good. */
function withdrawFailedSend<T extends Session>(
  session: T,
  sent: SentTask,
  failure: SendFailure,
  now: string,
): OwnerChange<T> {
  const withdrawn = withdrawSend(getTaskTable(session), sent.record.id, sent.send);
  const ended = failure.permanent
    ? endTask(withdrawn, findTask(withdrawn, sent.record.id)!, now)
    : { effects: [], table: withdrawn };
  const routed = routeSettledResults(setTaskTable(session, ended.table), ended.effects);
  return {
    events: taskEvents(ended.effects, session.sessionId),
    results: routed.results,
    session: routed.session,
  };
}

/**
 * Applies a send to a resumable workflow tool's task, from a model call with
 * `taskId`. The input goes to the run's command hook at once; the call
 * returns its receipt, or the send's error, such as `UNKNOWN_TASK`, first
 * among its results.
 */
export async function applyWorkflowSend<T extends Session>(input: {
  readonly call: WorkflowToolRunSendCall;
  readonly caller: SessionAuthContext | null;
  readonly ctx: ContextContainer | undefined;
  readonly now: string;
  readonly request: RuntimeWorkflowTaskRequest & { readonly taskId: string };
  readonly session: T;
}): Promise<OwnerChange<T>> {
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
  const error = refused ?? unknownSend(request.taskId, request.toolName);
  if (sent === undefined) {
    return { events: [], results: [taskToolErrorResult(request, error)], session };
  }
  const receipt = (started: boolean) =>
    sendReceiptResult({
      callId: request.callId,
      record: sent.record,
      started,
      toolName: request.toolName,
    });
  if (sent.kind === "existing") {
    return { events: [], results: [receipt(sent.record.callId === request.callId)], session };
  }
  const delivered = await deliverSend({
    call: input.call,
    callbackAlias: undefined,
    ctx: input.ctx,
    now: input.now,
    sent,
    session,
  });
  if (delivered.failure !== undefined) {
    const failed: RuntimeToolResultActionResult = {
      callId: request.callId,
      isError: true,
      kind: "tool-result",
      output: delivered.failure.output,
      toolName: request.toolName,
    };
    return { ...delivered, results: [failed, ...delivered.results] };
  }
  // The run announces the generation it starts for the send, which is the
  // one it read (see `adoptStartedGeneration`).
  return { events: [], results: [receipt(sent.started)], session: delivered.session };
}

/**
 * Runs the commands held for a child that just reported `task.started`. A
 * held send that cannot be delivered then is withdrawn and logged, and no
 * generation waits for it; the call that sent it already returned its
 * receipt. One an agent may have taken after all stays queued, unconfirmed,
 * and the sends held after it are withdrawn, since it must stay the last
 * send the agent may have (see `markSendUnconfirmed`). A stopped task's held
 * sends are not sent.
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
    let unconfirmed = false;
    for (const command of effect.commands.filter(isInputCommand)) {
      const send = effect.record.sends?.find((entry) => entry.seq === command.seq);
      if (!unconfirmed) {
        const failure = await sendTaskInput({ ...input, command, record: effect.record });
        if (failure === undefined) continue;
        if (failure.unconfirmed === true && send !== undefined) {
          unconfirmed = true;
          table = markSendUnconfirmed(table, effect.record.id, send);
          continue;
        }
      }
      log.error("a held send did not reach its task; its result will not reflect it", {
        taskId: effect.record.id,
      });
      if (send !== undefined) table = withdrawSend(table, effect.record.id, send);
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
}): Promise<Omit<OwnerChange<T>, "results">> {
  const retired = retireIdleTasks(getTaskTable(input.session), input.caller, input.now);
  if (retired.retired.length === 0) return { events: [], session: input.session };
  const session = setTaskTable(input.session, retired.table);
  const events = taskEvents(retired.effects, session.sessionId);
  const unreached = (
    await Promise.all(retired.retired.map((record) => retireIdleTask(record, input.ctx)))
  ).filter((child) => child !== undefined);
  if (unreached.length === 0) return { events, session };
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
  return { events, session };
}

function isInputCommand(command: TaskCommand): command is InputCommand {
  return command.kind === "input";
}
