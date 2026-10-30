import type { SessionEvent } from "#protocol/session-event.js";
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
  isActiveTaskRun,
  isCancelledTaskRun,
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
import { usageSince } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type {
  PublishedSessionEvents,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import { readHitlState } from "#harness/hitl/index.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { endTask, finishRun, settleTask } from "#harness/session-machine/transitions.js";
import { delegatedUsageFact } from "#harness/facts.js";
import { storedProjection, type SessionView } from "#harness/session-machine/view.js";
import { stopRuns, waitedCallRuns, type RunStopTarget } from "#execution/stop-runs.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskCancelReason } from "#execution/tasks/table.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "reply" | "started" | "usage" }
>;

const TASK_CANCEL_REASON = "The task was cancelled.";
const TURN_CANCEL_REASON = "The turn that called the tool was cancelled.";

/**
 * Applies one message from a task's run: started, a reply, usage no reply
 * carried, or the run's outcome. Call from a step and adopt the result.
 */
export async function applyTaskRunMessage(
  input: SessionStepState & { readonly message: TaskRunMessage },
): Promise<PublishedSessionEvents> {
  const { message } = input;
  const taskId = message.from.taskId;
  const session = readDurableSession(input.sessionState);
  if (taskId === undefined) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  let table = readTaskTable(session.state);
  const cancelled = isCancelledTaskRun(table, taskId, message.from.runId);
  const ended = storedProjection(session.state).view?.tasks[taskId]?.status === "ended";
  if (cancelled && (message.kind === "usage" || message.kind === "outcome")) {
    // The task already ended, so later spend counts without naming it again.
    const counted = countTaskRunUsage(table, taskId, message);
    table =
      message.kind === "outcome"
        ? finishTaskRun(counted.table, taskId, message.from.runId)
        : counted.table;
    return await commitSessionStep(
      { ...input, sessionState: saveTable(input.sessionState, session, table) },
      (view) => [
        {
          turn: view.turn,
          events: counted.spend === undefined ? [] : [delegatedUsageFact(undefined, counted.spend)],
        },
      ],
      { origin: "own" },
    );
  }
  if (cancelled && message.kind === "started") {
    // The run may not have existed when cancellation tried to stop it. Started follows
    // registration of its control hook; keep its address until the outcome arrives.
    await ignoreGoneTarget(
      resumeHook(findTask(table, taskId)!.run!.hookToken, {
        kind: "end",
        reason: TASK_CANCEL_REASON,
      }),
    );
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  if (ended || !isActiveTaskRun(table, taskId, message.from.runId))
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  const settles: Decision[] = [];
  const withdraws: Decision[] = [];
  let spend: TokenUsage | undefined;
  switch (message.kind) {
    case "started": {
      const started = markTaskRunStarted(table, taskId, message.from.runId);
      table = started.table;
      if (started.held !== undefined) await sendTaskRunCommands(started.held);
      break;
    }
    case "reply": {
      if (findTask(table, taskId)?.run?.runId !== message.from.runId) break;
      ({ table, spend } = countTaskRunUsage(table, taskId, message));
      const outcome: TaskOutcome = { output: message.output, status: "completed" };
      const record = findTask(table, taskId);
      const settled = settleTaskCalls(table, { callIds: message.callIds, outcome, taskId });
      table = settled.table;
      settles.push(...taskSettled(record, settled.settled, outcome));
      break;
    }
    case "usage":
      ({ table, spend } = countTaskRunUsage(table, taskId, message));
      break;
    case "outcome": {
      if (findTask(table, taskId)?.run?.runId !== message.from.runId) break;
      ({ table, spend } = countTaskRunUsage(table, taskId, message));
      const outcome = toOutcome(message);
      const record = findTask(table, taskId);
      const settled = settleRemainingTaskCalls(table, taskId, outcome);
      settles.push(...taskSettled(record, settled.settled, outcome));
      // The run's final spend lands while its task is still open, before `task.ended`.
      if (spend !== undefined)
        settles.push(spent([...settles], message.from.callId, spend, taskId));
      spend = undefined;
      // Nobody can answer what a finished run relayed, so channels stop offering it. The
      // withdrawals commit first, so the task's own end leaves them alone.
      const requestIds = runRequestIds(session, message.from.runId);
      withdraws.push((view) => finishRun(view, { requestIds, taskId }));
      settles.push((view) => endTask(view, { outcome, taskId }));
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      break;
    }
  }
  return await commitTaskDecisions(input, saveTable(input.sessionState, session, table), {
    settles:
      spend === undefined
        ? settles
        : [...settles, spent(settles, message.from.callId, spend, taskId)],
    withdraws,
  });
}

/**
 * Delegated spend, owned by the call this commit settles. One reply may settle several calls
 * with the same result; its spend belongs once to the latest served call (the message's
 * source), never once per recipient. A serve body can keep spending after it replied or while
 * cancellation unwinds: no open call owns that, and an immutable settlement can't be amended,
 * so it is the task's own `delegated-late` usage.
 */
function spendFact(
  events: readonly SessionEvent[],
  sourceCallId: string | undefined,
  spend: TokenUsage,
  taskId: string,
): SessionEvent {
  const settled = events.filter((event) => event.type === "call.settled");
  const call = settled.find((event) => event.data.callId === sourceCallId) ?? settled[0];
  if (call !== undefined) return delegatedUsageFact(call.data.callId, spend);
  return { ...delegatedUsageFact(undefined, spend), scope: { taskId } };
}

/**
 * Cancels tasks, and the calls the turn waits on when `turnCalls` is set. The tasks' calls
 * settle as cancelled and the session publishes that first. A cancelled agent or `task()` task
 * ends now, without waiting for its run to finish cleanup. A resumable tool's run only stops its
 * current stretch.
 *
 * A `task()` run's cancel settles every request it relayed, so the session withdraws them in
 * the same step and accepts no answer after it. A `serve()` run withdraws its stretch's
 * questions itself, and the session decides each one.
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
  /** Also stop the workflow tool runs the turn waits on. */
  readonly turnCalls?: boolean;
}

async function cancelTasks(
  input: SessionStepState & TaskCancellationInput,
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(input.sessionState);
  let table = readTaskTable(session.state);
  const settles: Decision[] = [];
  const withdraws: Decision[] = [];
  const outcome: TaskOutcome = { reason: input.reason, status: "cancelled" };
  const targets: RunStopTarget[] = [];
  const calls = input.turnCalls === true ? waitedCallRuns(session) : [];
  for (const taskId of input.taskIds) {
    const record = findTask(table, taskId);
    const cancelled = cancelTask(table, taskId);
    table = cancelled.table;
    settles.push(...taskSettled(record, cancelled.settled, outcome));
    if (record?.resumable === false || record?.kind === "agent")
      settles.push((view) => endTask(view, { outcome, taskId }));
    if (cancelled.send === undefined) continue;
    // A `task()` run's cancel settles what it relayed; a `serve()` run withdraws its own.
    if (record?.resumable === false || record?.kind === "agent") {
      const requestIds = runRequestIds(session, cancelled.send.run.runId);
      withdraws.push((view) => finishRun(view, { requestIds, taskId }));
    }
    targets.push({
      ends: record?.resumable === false || record?.kind === "agent",
      run: cancelled.send.run,
    });
  }
  const committed = await commitTaskDecisions(
    input,
    saveTable(input.sessionState, session, table),
    { settles, withdraws },
  );
  const [cancelledOutright] = await Promise.all([
    stopRuns(
      targets.filter((target) => target.ends),
      { kind: "end", reason: TASK_CANCEL_REASON },
      { waitForEnd: false },
    ),
    stopRuns(
      targets.filter((target) => !target.ends),
      { kind: "cancel", reason: TASK_CANCEL_REASON },
      { waitForEnd: false },
    ),
    stopRuns(calls, { kind: "cancel", reason: TURN_CANCEL_REASON }),
  ]);
  if (cancelledOutright.length === 0) return committed;
  const current = readDurableSession(committed.sessionState);
  let finished = readTaskTable(current.state);
  const cancelledRuns = new Set(cancelledOutright);
  for (const record of finished.tasks) {
    if (record.run !== undefined && cancelledRuns.has(record.run.runId))
      finished = finishTaskRun(finished, record.id, record.run.runId);
  }
  return { ...committed, sessionState: saveTable(committed.sessionState, current, finished) };
}

/** A transition a task step decides against the session it commits to. */
type Decision = (view: SessionView) => Transition;

/**
 * Commits a task step's decisions to the session with its saved table: the requests it
 * withdraws, which this session relayed, and then its own `task.settled` events.
 */
async function commitTaskDecisions(
  input: SessionStepState,
  sessionState: DurableSessionState,
  decisions: { readonly settles: readonly Decision[]; readonly withdraws: readonly Decision[] },
): Promise<PublishedSessionEvents> {
  const relayed = await commitSessionStep(
    { ...input, sessionState },
    (view) => decisions.withdraws.map((decide) => decide(view)),
    { origin: "relayed" },
  );
  return await commitSessionStep(
    { ...input, ...relayed },
    (view) => decisions.settles.map((decide) => decide(view)),
    { origin: "own" },
  );
}

/** The spend a task run's message reports, as a fact after the calls `settles` settle. */
function spent(
  settles: readonly Decision[],
  sourceCallId: string | undefined,
  spend: TokenUsage,
  taskId: string,
): Decision {
  return (view) => ({
    events: [
      spendFact(
        settles.flatMap((decide) => decide(view).events),
        sourceCallId,
        spend,
        taskId,
      ),
    ],
    turn: view.turn,
  });
}

/** Settles a task's settled calls; calls only settle on a known task. */
function taskSettled(
  record: TaskRecord | undefined,
  calls: readonly TaskCall[],
  outcome: TaskOutcome,
): readonly Decision[] {
  if (record === undefined) return [];
  return [(view) => settleTask(view, { calls, outcome })];
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
 * The new spend the cumulative total a reply, usage report, or outcome carries adds to what was
 * recorded from its run, which the caller records as a fact; the task remembers the total. Only
 * while that run is the task's run: a redelivered outcome arrives after the run finished, and
 * adds nothing.
 */
function countTaskRunUsage(
  table: TaskTable,
  taskId: string,
  message: Extract<TaskRunMessage, { readonly kind: "outcome" | "reply" | "usage" }>,
): { readonly table: TaskTable; readonly spend?: TokenUsage } {
  const run = findTask(table, taskId)?.run;
  if (message.usage === undefined || run?.runId !== message.from.runId) return { table };
  const delta = usageSince(message.usage, run.usage);
  const changed =
    delta.inputTokens !== 0 ||
    delta.outputTokens !== 0 ||
    delta.cacheReadTokens !== 0 ||
    delta.cacheWriteTokens !== 0 ||
    (delta.costUsd !== undefined && (delta.costUsd !== 0 || run.usage?.costUsd === undefined));
  return {
    table: recordTaskRunUsage(table, taskId, message.usage),
    spend: changed ? delta : undefined,
  };
}

/** The requests a run relayed: its own questions and those of the sessions it opened. */
function runRequestIds(session: DurableSession, runId: string): readonly string[] {
  return [...readHitlState(session.state).relays]
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
