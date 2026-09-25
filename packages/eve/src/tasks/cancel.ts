import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { coordinationTurnId, getPendingCoordinationBatch } from "#harness/coordination.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { readTaskCancelId } from "#tasks/cancel-tool.js";
import { taskEvents, type TaskLifecycleStreamEvent } from "#tasks/events.js";
import { commandEffects, readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { findCallerTask } from "#tasks/owner-calls.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { taskToolErrorResult } from "#tasks/receipts.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  discardTaskResults,
  isTaskOf,
  workingTaskIds,
  type PendingTaskResult,
} from "#tasks/results.js";
import {
  renderInterruptedCall,
  TASK_CANCEL_INVALID_INPUT_MESSAGE,
  type TaskCancelOutput,
} from "#tasks/render.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { cancelTask, hasCancellableWork, type TaskTable } from "#tasks/table.js";
import { endAllTasks } from "#tasks/table-generations.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";
import { endTaskWaits, takeLiveWait } from "#tasks/wait.js";

// Owner-side cancellation: record the outcome at once, ask each started child
// to stop, and never wait for it. The timer hard-stops a child that does not
// confirm in time. A `task_wait` on a cancelled task gets the cancellation as
// its result; cancelled work otherwise never reaches the model.

const log = createLogger("tasks.cancel");

/**
 * Which working tasks {@link cancelTasksStep} cancels. Idle tasks are not
 * working, so every selector leaves them available. Work never outlives its
 * turn: the selectors that end a turn early also discard the results of its
 * tasks that settled before the turn read them.
 */
export type TaskCancelSelector =
  /** Every working task: `session.cancel()`, a cancelled turn, or the session's end. */
  | { readonly kind: "all" }
  /** The working tasks one turn started: a cancel named that turn after it ended. */
  | { readonly kind: "turn"; readonly turnId: string }
  /**
   * The working tasks that hold a principal's turn open (see
   * `workingTaskIds`): that turn failed, or replied to its caller early.
   */
  | { readonly kind: "held"; readonly principal: SessionAuthContext | null }
  /** The agent calls a workflow run awaits, once that run ends. */
  | { readonly kind: "workflow-run"; readonly runId: string }
  /** One `ctx.agent` call of a workflow run, whose `signal` aborted. */
  | { readonly kind: "agent-call"; readonly runId: string; readonly callId: string };

/** The owner's table after cancelling tasks, and what it must send and publish. */
interface CancelledTasks {
  readonly table: TaskTable;
  readonly commands: readonly CommandEffect[];
  readonly events: readonly TaskLifecycleStreamEvent[];
}

type Session = { readonly sessionId: string; readonly state?: SessionStateMap };

/**
 * Records cancellation for every working task the selector picks, reports
 * each as settled, and asks each started child to stop. It never waits for
 * the child to confirm, and the confirmation reports nothing.
 */
export async function cancelTasksStep(input: {
  readonly selector: TaskCancelSelector;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const discarded = discardTaskResults(
    durable,
    selectResults(input.selector, getTaskTable(durable)),
  );
  const initial = getTaskTable(discarded.session);
  const selected = initial.records.filter(selectTasks(input.selector, discarded.session));
  const cancelled = cancelRecords(initial, selected, new Date().toISOString(), durable.sessionId);
  if (cancelled.table === initial && discarded.discarded.length === 0) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }
  if (discarded.discarded.length > 0) {
    log.debug("discarded results of tasks whose turn ended early", {
      sessionId: durable.sessionId,
      taskIds: discarded.discarded.map(({ taskId }) => taskId),
    });
  }
  if (cancelled.commands.length > 0) {
    await runCommands(cancelled.commands, await readContext(input.serializedContext));
  }
  const applied = applyCancelled(
    discarded.session,
    cancelled.table,
    selected.filter((record) => !isTerminalTaskStatus(record.status)),
  );
  return {
    events: cancelled.events,
    replies: [],
    results: applied.results,
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      session: applied.session,
      state: input.sessionState,
    }),
  };
}

/**
 * Ends every task that has not ended, as the owner session ends and after
 * its children were asked to stop: each task's remaining generations settle
 * and it publishes `task.ended`. Nothing is delivered afterwards.
 */
export async function endTasksStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const ended = endAllTasks(getTaskTable(durable), new Date().toISOString());
  return {
    events: taskEvents(ended.effects, durable.sessionId),
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      session: setTaskTable(durable, ended.table),
      state: input.sessionState,
    }),
  };
}

/**
 * Ends the attached calls of the active turn that a steering message
 * interrupts, or whose dismissed question's grace period ran out. Each
 * `task_wait` among `callIds` returns `interrupted`, and each attached task
 * among them is cancelled through the normal cancel path, with the
 * interruption text as its tool result. Detached tasks keep working.
 */
export async function interruptAttachedCallsStep(input: {
  readonly callIds: readonly string[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const now = new Date().toISOString();
  const waits = endTaskWaits(durable, { callIds: input.callIds, now, reason: "interrupted" });
  const stopped = interruptAttachedCalls({
    callIds: input.callIds,
    now,
    session: waits.session,
    turnId: coordinationTurnId(durable.state, input.sessionState.emissionState),
  });
  if (stopped.session === durable) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }
  if (stopped.commands.length > 0) {
    await runCommands(stopped.commands, await readContext(input.serializedContext));
  }
  return {
    events: stopped.events,
    replies: [],
    results: [...waits.results, ...stopped.results],
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      session: stopped.session,
      state: input.sessionState,
    }),
  };
}

/**
 * The transition behind {@link interruptAttachedCallsStep} for attached
 * tasks. A call whose task already settled is left alone: its result is on
 * its way to the turn.
 */
export function interruptAttachedCalls<T extends Session>(input: {
  readonly callIds: readonly string[];
  readonly now: string;
  readonly session: T;
  readonly turnId: string;
}): Omit<CancelledTasks, "table"> & {
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly session: T;
} {
  const table = getTaskTable(input.session);
  const selected = table.records.filter(
    (record) =>
      input.callIds.includes(record.callId) &&
      record.turnId === input.turnId &&
      record.mode === "attached" &&
      record.workflowCaller === undefined &&
      !isTerminalTaskStatus(record.status),
  );
  if (selected.length === 0)
    return { commands: [], events: [], results: [], session: input.session };
  const calls = getPendingCoordinationBatch(input.session.state)?.tasks ?? [];
  const cancelled = cancelRecords(table, selected, input.now, input.session.sessionId);
  const results = selected.map((record): RuntimeToolResultActionResult => {
    const waitedMs = Math.max(0, Date.parse(input.now) - Date.parse(record.startedAt));
    return {
      callId: record.callId,
      kind: "tool-result",
      modelOutput: renderInterruptedCall(waitedMs),
      output: { status: "interrupted", waitedMs },
      toolName: calls.find((call) => call.callId === record.callId)?.toolName ?? record.name,
    };
  });
  return {
    commands: cancelled.commands,
    events: cancelled.events,
    results,
    session: setTaskTable(input.session, cancelled.table),
  };
}

/**
 * Applies one model call that stops a detached task: its working generation
 * and the sends queued for it. That work never reports, except to a
 * `task_wait` on it; a finished generation keeps its result. A call its turn still waits on is unknown, and a task
 * another principal started is refused. The caller sends the commands and
 * publishes the events.
 */
export function applyTaskCancelCall<T extends Session>(input: {
  readonly caller: SessionAuthContext | null;
  readonly now: string;
  readonly request: RuntimeWorkflowTaskRequest;
  readonly session: T;
}): Omit<CancelledTasks, "table"> & {
  /** The call's own result, then the result of each `task_wait` the cancel ended. */
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly session: T;
} {
  const { request, session } = input;
  const unchanged = (result: RuntimeToolResultActionResult) => ({
    commands: [],
    events: [],
    results: [result],
    session,
  });
  const taskId = readTaskCancelId(request.input);
  if (taskId === undefined) {
    const error = { code: "INVALID_INPUT", message: TASK_CANCEL_INVALID_INPUT_MESSAGE };
    return unchanged(taskToolErrorResult(request, error));
  }
  const table = getTaskTable(session);
  const found = findCallerTask({ caller: input.caller, table, taskId });
  if ("error" in found) return unchanged(taskToolErrorResult(request, found.error));
  const { record } = found;
  if (!hasCancellableWork(record)) {
    return unchanged(cancelResult(request, { status: "already_finished" }));
  }
  const cancelled = cancelRecords(table, [record], input.now, session.sessionId);
  const applied = applyCancelled(session, cancelled.table, [record]);
  return {
    commands: cancelled.commands,
    events: cancelled.events,
    results: [cancelResult(request, { status: "cancelled" }), ...applied.results],
    session: applied.session,
  };
}

function cancelResult(
  request: RuntimeWorkflowTaskRequest,
  output: TaskCancelOutput,
): RuntimeToolResultActionResult {
  return {
    callId: request.callId,
    kind: "tool-result",
    output: { ...output },
    toolName: request.toolName,
  };
}

/**
 * Writes the cancelled table, and gives each live `task_wait` on a cancelled
 * task the cancellation as its result.
 */
function applyCancelled<T extends Session>(
  session: T,
  table: TaskTable,
  cancelled: readonly TaskRecord[],
): { readonly results: readonly RuntimeToolResultActionResult[]; readonly session: T } {
  let next = setTaskTable(session, table);
  const results: RuntimeToolResultActionResult[] = [];
  for (const record of cancelled) {
    const waited = takeLiveWait(next, record, { status: "cancelled" });
    next = waited.session;
    if (waited.result !== undefined) results.push(waited.result);
  }
  return { results, session: next };
}

function selectTasks(
  selector: TaskCancelSelector,
  session: Session,
): (record: TaskRecord) => boolean {
  switch (selector.kind) {
    case "all":
      return () => true;
    case "turn":
      return (record) => record.turnId === selector.turnId;
    case "held": {
      const working = new Set(workingTaskIds(session, selector.principal));
      return (record) => working.has(record.id);
    }
    case "workflow-run":
      return (record) => record.workflowCaller?.runId === selector.runId;
    case "agent-call":
      return (record) =>
        record.workflowCaller?.runId === selector.runId && record.callId === selector.callId;
  }
}

/** The held results a selector that ends a turn early discards. */
function selectResults(
  selector: TaskCancelSelector,
  table: TaskTable,
): (result: PendingTaskResult) => boolean {
  switch (selector.kind) {
    case "all":
      return () => true;
    case "turn":
      return (result) =>
        table.records.some(
          (record) => record.id === result.taskId && record.turnId === selector.turnId,
        );
    case "held":
      return (result) => isTaskOf(result, selector.principal);
    case "workflow-run":
    case "agent-call":
      return () => false;
  }
}

/**
 * Cancels the working agent calls that the given workflow runs await
 * through `ctx.agent`. A run that is stopped may never report its outcome,
 * so its agents would otherwise run until their own time limit.
 */
export function cancelRunAgents(
  table: TaskTable,
  runIds: ReadonlySet<string>,
  now: string,
  ownerSessionId: string,
): CancelledTasks {
  if (runIds.size === 0) return { commands: [], events: [], table };
  return cancelRecords(
    table,
    table.records.filter(
      (record) => record.workflowCaller !== undefined && runIds.has(record.workflowCaller.runId),
    ),
    now,
    ownerSessionId,
  );
}

/** Cancels each working record, and the agent calls of each workflow run among them. */
function cancelRecords(
  table: TaskTable,
  selected: readonly TaskRecord[],
  now: string,
  ownerSessionId: string,
): CancelledTasks {
  const runIds = new Set(
    selected.flatMap((record) => (record.child?.kind === "workflow" ? [record.child.runId] : [])),
  );
  const records = [
    ...selected,
    ...table.records.filter(
      (record) =>
        record.workflowCaller !== undefined &&
        runIds.has(record.workflowCaller.runId) &&
        !selected.includes(record),
    ),
  ];
  let next = table;
  const commands: CommandEffect[] = [];
  const events: TaskLifecycleStreamEvent[] = [];
  for (const record of records) {
    if (!hasCancellableWork(record)) continue;
    // Queued sends settle as their generations come up.
    const cancelled = cancelTask(next, record.id, now);
    next = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
    events.push(...taskEvents(cancelled.effects, ownerSessionId));
  }
  return { commands, events, table: next };
}
