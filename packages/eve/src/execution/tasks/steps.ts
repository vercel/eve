import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { TaskHardStopWorkflowInput } from "#execution/tasks/hard-stop-workflow.js";
import {
  cancelTask,
  finishTaskRun,
  markTaskRunStarted,
  nextHardStopDue,
  readTaskTable,
  setHardStopAt,
  settleRemainingTaskCalls,
  settleTaskCall,
  takeOverdueRuns,
  writeTaskTable,
  type TaskCallOutcome,
  type TaskRunCommand,
  type TaskRunCommands,
  type TaskSettlement,
  type TaskTable,
} from "#execution/tasks/table.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import {
  publishSessionEvents,
  type PublishedSessionEvents,
  type SessionEventTarget,
} from "#execution/publish-session-events.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import {
  startWorkflowOnCurrentDeployment,
  taskHardStopWorkflowReference,
} from "#execution/workflow-runtime.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createTaskSettledEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "reply" | "started" }
>;

interface TaskStepResult {
  readonly sessionState: DurableSessionState;
}

const TASK_CANCEL_REASON = "The task was cancelled.";

/** Applies one message from a task's run: started, a reply, or the run's outcome. */
export async function applyTaskRunMessageStep(
  input: SessionEventTarget & { readonly message: TaskRunMessage },
): Promise<PublishedSessionEvents> {
  "use step";

  const { message } = input;
  const taskId = message.from.taskId;
  let session = readDurableSession(input.sessionState);
  if (taskId === undefined) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  let table = readTaskTable(session.state);
  const settlements: TaskSettlement[] = [];
  switch (message.kind) {
    case "started": {
      const started = markTaskRunStarted(table, taskId, message.from.runId);
      table = started.table;
      if (started.held !== undefined) await sendTaskRunCommands(started.held);
      break;
    }
    case "reply": {
      const settled = settleTaskCall(table, {
        callId: message.from.callId,
        outcome: { output: message.output, status: "completed" },
        taskId,
      });
      table = settled.table;
      if (settled.settlement !== undefined) settlements.push(settled.settlement);
      break;
    }
    case "outcome": {
      const settled = settleRemainingTaskCalls(table, taskId, toCallOutcome(message));
      settlements.push(...settled.settlements);
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      session = forgetRunQuestions(session, message.from.runId);
      break;
    }
  }
  const sessionState = saveTable(input.sessionState, session, table);
  return await publishSessionEvents({ ...input, sessionState }, settlements.map(taskSettledEvent));
}

/**
 * Cancels tasks: their calls settle as cancelled, their runs are told to
 * stop, and the sleeper is armed to hard-stop any run that doesn't confirm.
 */
export async function cancelTasksStep(
  input: SessionEventTarget & {
    readonly inbox: string;
    readonly taskIds: readonly string[];
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const now = Date.now();
  let table = readTaskTable(session.state);
  const settlements: TaskSettlement[] = [];
  for (const taskId of input.taskIds) {
    const cancelled = cancelTask(table, taskId, now);
    table = cancelled.table;
    settlements.push(...cancelled.settlements);
    if (cancelled.send !== undefined) await sendTaskRunCommands(cancelled.send);
  }
  table = await armHardStop(table, input.inbox);
  const sessionState = saveTable(input.sessionState, session, table);
  return await publishSessionEvents({ ...input, sessionState }, settlements.map(taskSettledEvent));
}

/** Hard-stops every cancelled run whose confirmation is overdue, then re-arms the sleeper. */
export async function hardStopOverdueTasksStep(input: {
  readonly inbox: string;
  readonly sessionState: DurableSessionState;
}): Promise<TaskStepResult> {
  "use step";

  let session = readDurableSession(input.sessionState);
  const overdue = takeOverdueRuns(readTaskTable(session.state), Date.now());
  const world = await getWorld();
  for (const run of overdue.runs) {
    await ignoreGoneTarget(cancelRun(world, run.runId, { cancelReason: TASK_CANCEL_REASON }));
    session = forgetRunQuestions(session, run.runId);
  }
  const table = await armHardStop(setHardStopAt(overdue.table, undefined), input.inbox);
  return { sessionState: saveTable(input.sessionState, session, table) };
}

/** The `task.settled` event for one settled call. */
function taskSettledEvent(settlement: TaskSettlement): UnstampedMessageStreamEvent {
  const base = { callId: settlement.callId, taskId: settlement.taskId };
  switch (settlement.status) {
    case "completed":
      return createTaskSettledEvent({ ...base, output: settlement.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({
        ...base,
        error: { message: settlement.error },
        status: "failed",
      });
    case "cancelled":
      return createTaskSettledEvent({ ...base, status: "cancelled" });
  }
}

/** Starts the session's one sleeper for the earliest pending confirmation, unless one is armed. */
async function armHardStop(table: TaskTable, inbox: string): Promise<TaskTable> {
  const dueAt = nextHardStopDue(table);
  if (dueAt === undefined || table.hardStopAt !== undefined) return table;
  const input: TaskHardStopWorkflowInput = { dueAt, inbox };
  await startWorkflowOnCurrentDeployment(taskHardStopWorkflowReference, [input]);
  return setHardStopAt(table, dueAt);
}

/**
 * Sends commands to a task's run, in order. A run that already finished takes
 * none; its outcome settles any call still waiting.
 */
export async function sendTaskRunCommands(commands: TaskRunCommands): Promise<void> {
  for (const command of commands.commands) {
    await ignoreGoneTarget(resumeHook(commands.run.hookToken, toControlMessage(command)));
  }
}

function toControlMessage(command: TaskRunCommand): WorkflowToolRunControlMessage {
  switch (command.kind) {
    case "cancel":
      return { kind: "cancel", reason: TASK_CANCEL_REASON };
    case "call":
      return { call: command.call, kind: "call" };
  }
}

async function ignoreGoneTarget(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
  }
}

function toCallOutcome(message: WorkflowToolRunOutcomeMessage): TaskCallOutcome {
  switch (message.result.status) {
    case "completed":
      return { output: message.result.output, status: "completed" };
    case "failed":
      return { error: failureMessage(message), status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

function failureMessage(message: WorkflowToolRunOutcomeMessage): string {
  const output = workflowToolRunFailureOutput(message);
  if (typeof output === "string") return output;
  const described =
    typeof output === "object" && output !== null ? Reflect.get(output, "message") : undefined;
  return typeof described === "string" ? described : JSON.stringify(output);
}

/** A finished run can no longer take answers, so its unanswered questions are dropped. */
function forgetRunQuestions(session: DurableSession, runId: string): DurableSession {
  return clearProxyInputRequestsWhere(session, (route) => route.answerHook?.runId === runId);
}

function saveTable(
  state: DurableSessionState,
  session: DurableSession,
  table: TaskTable,
): DurableSessionState {
  return replaceDurableSessionSnapshot({ session: writeTaskTable(session, table), state });
}
