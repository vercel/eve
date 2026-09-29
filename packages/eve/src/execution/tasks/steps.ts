import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  cancelTask,
  findTask,
  finishTaskRun,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRunUsage,
  settleRemainingTaskCalls,
  settleTaskCalls,
  writeTaskTable,
  type TaskCall,
  type TaskOutcome,
  type TaskRunCommand,
  type TaskRunCommands,
  type TaskTable,
} from "#execution/tasks/table.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";
import {
  publishSessionEvents,
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import { withdrawWorkflowAsks } from "#execution/tools/workflow/withdraw-step.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createTaskSettledEvent, type TaskSettledStreamEvent } from "#protocol/message.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "reply" | "started" | "usage" }
>;

const TASK_CANCEL_REASON = "The task was cancelled.";

/** Applies one message from a task's run: started, a reply, usage no reply carried, or the run's outcome. */
export async function applyTaskRunMessageStep(
  input: SessionStepState & { readonly message: TaskRunMessage },
): Promise<PublishedSessionEvents> {
  "use step";

  const { message } = input;
  const taskId = message.from.taskId;
  let session = readDurableSession(input.sessionState);
  if (taskId === undefined) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  let table = readTaskTable(session.state);
  const events: TaskSettledStreamEvent[] = [];
  switch (message.kind) {
    case "started": {
      const started = markTaskRunStarted(table, taskId, message.from.runId);
      table = started.table;
      if (started.held !== undefined) await sendTaskRunCommands(started.held);
      break;
    }
    case "reply": {
      ({ session, table } = countTaskRunUsage(session, table, taskId, message));
      const outcome: TaskOutcome = { output: message.output, status: "completed" };
      const settled = settleTaskCalls(table, { callIds: message.callIds, outcome, taskId });
      table = settled.table;
      events.push(...settled.settled.map((call) => taskSettledEvent(taskId, call, outcome)));
      break;
    }
    case "usage":
      ({ session, table } = countTaskRunUsage(session, table, taskId, message));
      break;
    case "outcome": {
      ({ session, table } = countTaskRunUsage(session, table, taskId, message));
      const outcome = toOutcome(message);
      const settled = settleRemainingTaskCalls(table, taskId, outcome);
      events.push(...settled.settled.map((call) => taskSettledEvent(taskId, call, outcome)));
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      session = forgetRunQuestions(session, message.from.runId);
      break;
    }
  }
  return await publishSessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, session, table) },
    events,
  );
}

/**
 * Cancels tasks: their calls settle as cancelled and their runs are told to
 * stop. A run ends itself within its cleanup deadline and reports cancelled.
 * A `task()` run's cancel settles its questions, so the session withdraws
 * them in the same step and accepts no answer after it. A `serve()` run
 * withdraws its stretch's questions itself, and the session decides each one.
 */
export async function cancelTasksStep(
  input: SessionStepState & { readonly taskIds: readonly string[] },
): Promise<PublishedSessionEvents> {
  "use step";

  const session = readDurableSession(input.sessionState);
  let table = readTaskTable(session.state);
  const events: TaskSettledStreamEvent[] = [];
  const stoppedRunIds = new Set<string>();
  for (const taskId of input.taskIds) {
    const resumable = findTask(table, taskId)?.resumable;
    const cancelled = cancelTask(table, taskId);
    table = cancelled.table;
    events.push(...cancelled.settled.map((call) => taskSettledEvent(taskId, call, CANCELLED)));
    if (cancelled.send === undefined) continue;
    if (resumable === false) stoppedRunIds.add(cancelled.send.run.runId);
    await sendTaskRunCommands(cancelled.send);
  }
  const withdrawn = withdrawWorkflowAsks(session, (_requestId, runId) => stoppedRunIds.has(runId));
  const relayed = await relaySessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, withdrawn.session, table) },
    withdrawn.events,
  );
  return await publishSessionEvents({ ...input, ...relayed }, events);
}

const CANCELLED: TaskOutcome = { status: "cancelled" };

/** The `task.settled` event for one settled call. */
function taskSettledEvent(
  taskId: string,
  call: TaskCall,
  outcome: TaskOutcome,
): TaskSettledStreamEvent {
  const base = { callId: call.callId, taskId, turnId: call.turnId };
  switch (outcome.status) {
    case "completed":
      return createTaskSettledEvent({ ...base, output: outcome.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({
        ...base,
        error: { message: outcome.error },
        status: "failed",
      });
    case "cancelled":
      return createTaskSettledEvent({ ...base, status: "cancelled" });
  }
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

function toOutcome(message: WorkflowToolRunOutcomeMessage): TaskOutcome {
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

/**
 * Counts what the delegated spend a reply, usage report, or outcome carries
 * adds to what the session counted from its run. Only while that run is the
 * task's run: a redelivered outcome arrives after the run finished, and adds
 * nothing.
 */
function countTaskRunUsage(
  session: DurableSession,
  table: TaskTable,
  taskId: string,
  message: Extract<TaskRunMessage, { readonly kind: "outcome" | "reply" | "usage" }>,
): { readonly session: DurableSession; readonly table: TaskTable } {
  const run = findTask(table, taskId)?.run;
  if (message.usage === undefined || run?.runId !== message.from.runId) return { session, table };
  return {
    session: countRunUsage(session, message.usage, run.usage),
    table: recordTaskRunUsage(table, taskId, message.usage),
  };
}

/** A finished run can no longer take answers, so its unanswered questions are dropped. */
function forgetRunQuestions(session: DurableSession, runId: string): DurableSession {
  return clearProxyInputRequestsWhere(session, (route) => route.workflowAsk?.runId === runId);
}

function saveTable(
  state: DurableSessionState,
  session: DurableSession,
  table: TaskTable,
): DurableSessionState {
  return replaceDurableSessionSnapshot({ session: writeTaskTable(session, table), state });
}
