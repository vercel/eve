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
  type TaskRecord,
  type TaskRunCommand,
  type TaskRunCommands,
  type TaskTable,
} from "#execution/tasks/table.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";
import type {
  PublishedSessionEvents,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { commitSessionStep } from "#execution/session/commit-step.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { finishRun, settleTask } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskCancelReason } from "#protocol/message.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "reply" | "started" | "usage" }
>;

const TASK_CANCEL_REASON = "The task was cancelled.";

/** Applies one message from a task's run: started, a reply, usage no reply carried, or the run's outcome. */
export async function applyTaskRunMessageStep(
  input: SessionStepState & { readonly message: TaskRunMessage },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, applyTaskRunMessage);
}

async function applyTaskRunMessage(
  input: SessionStepState & { readonly message: TaskRunMessage },
): Promise<PublishedSessionEvents> {
  const { message } = input;
  const taskId = message.from.taskId;
  let session = readDurableSession(input.sessionState);
  if (taskId === undefined) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  let table = readTaskTable(session.state);
  const settlements: TaskSettlement[] = [];
  const finished: FinishedRun[] = [];
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
      const record = findTask(table, taskId);
      const settled = settleTaskCalls(table, { callIds: message.callIds, outcome, taskId });
      table = settled.table;
      settlements.push({ calls: settled.settled, outcome, record });
      break;
    }
    case "usage":
      ({ session, table } = countTaskRunUsage(session, table, taskId, message));
      break;
    case "outcome": {
      ({ session, table } = countTaskRunUsage(session, table, taskId, message));
      const outcome = toOutcome(message);
      const record = findTask(table, taskId);
      const settled = settleRemainingTaskCalls(table, taskId, outcome);
      settlements.push({ calls: settled.settled, outcome, record });
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      // Nobody can answer what a finished run relayed, so channels stop offering it.
      finished.push({ requestIds: runRequestIds(session, message.from.runId), taskId });
      break;
    }
  }
  return await commitTaskSteps(input, saveTable(input.sessionState, session, table), {
    finished,
    settlements,
  });
}

/**
 * Cancels tasks: their calls settle as cancelled and their runs are told to
 * stop. A run ends itself within its cleanup deadline and reports cancelled.
 * A `task()` run's cancel settles every request it relayed, so the session
 * withdraws them in the same step and accepts no answer after it. A `serve()`
 * run withdraws its stretch's questions itself, and the session decides each one.
 */
export async function cancelTasksStep(
  input: SessionStepState & TaskCancellationInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, cancelTasks);
}

interface TaskCancellationInput {
  readonly reason: TaskCancelReason;
  readonly taskIds: readonly string[];
}

async function cancelTasks(
  input: SessionStepState & TaskCancellationInput,
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(input.sessionState);
  let table = readTaskTable(session.state);
  const settlements: TaskSettlement[] = [];
  const finished: FinishedRun[] = [];
  const outcome: TaskOutcome = { reason: input.reason, status: "cancelled" };
  for (const taskId of input.taskIds) {
    const record = findTask(table, taskId);
    const cancelled = cancelTask(table, taskId);
    table = cancelled.table;
    settlements.push({ calls: cancelled.settled, outcome, record });
    if (cancelled.send === undefined) continue;
    // A `task()` run's cancel settles what it relayed; a `serve()` run withdraws its own.
    if (record?.resumable === false) {
      finished.push({ requestIds: runRequestIds(session, cancelled.send.run.runId), taskId });
    }
    await sendTaskRunCommands(cancelled.send);
  }
  return await commitTaskSteps(input, saveTable(input.sessionState, session, table), {
    finished,
    settlements,
  });
}

/** A task's calls that settled with one outcome. */
interface TaskSettlement {
  readonly calls: readonly TaskCall[];
  readonly outcome: TaskOutcome;
  readonly record: TaskRecord | undefined;
}

/** A run that ended, and the requests it relayed. */
type FinishedRun = Parameters<typeof finishRun>[1];

/**
 * Commits a task step once its table is saved: the requests finished runs relayed are withdrawn
 * first, then the settled calls report, as two machine commits.
 */
async function commitTaskSteps(
  input: SessionStepState,
  sessionState: DurableSessionState,
  step: {
    readonly finished: readonly FinishedRun[];
    readonly settlements: readonly TaskSettlement[];
  },
): Promise<PublishedSessionEvents> {
  const relayed = await commitSessionStep({ ...input, sessionState }, (view) =>
    unchanged(
      view,
      step.finished.flatMap((run) => finishRun(view, run).events),
    ),
  );
  return await commitSessionStep(
    { ...input, ...relayed },
    (view) =>
      unchanged(
        view,
        // Calls only settle on a known task.
        step.settlements.flatMap(({ calls, outcome, record }) =>
          record === undefined ? [] : settleTask(view, { calls, outcome, task: record }).events,
        ),
      ),
    "own",
  );
}

function unchanged(view: SessionView, events: Transition["events"]): Transition {
  return { events, turn: view.turn };
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

/** The requests a run relayed: its own questions and those of the sessions it opened. */
function runRequestIds(session: DurableSession, runId: string): readonly string[] {
  return [...getProxyInputRequests(session.state)]
    .filter(([, route]) => route.runId === runId)
    .map(([requestId]) => requestId);
}

function saveTable(
  state: DurableSessionState,
  session: DurableSession,
  table: TaskTable,
): DurableSessionState {
  return replaceDurableSessionSnapshot({ session: writeTaskTable(session, table), state });
}
