import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { coordinationTurnId, getPendingCoordinationBatch } from "#harness/coordination.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import type { TaskSettledStreamEvent } from "#protocol/message.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { readTaskCancelId } from "#tasks/cancel-tool.js";
import { taskSettledEvent } from "#tasks/events.js";
import { commandEffects, readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { findCallerTask } from "#tasks/owner-calls.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { taskToolErrorResult } from "#tasks/receipts.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderInterruptedCall,
  TASK_CANCEL_INVALID_INPUT_MESSAGE,
  type TaskCancelOutput,
} from "#tasks/render.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { cancelTask, type TaskTable } from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";
import { endTaskWaits, takeLiveWait } from "#tasks/wait.js";

// Owner-side cancellation: record the outcome at once, ask each started child
// to stop, and never wait for it. The timer hard-stops a child that does not
// confirm in time. A `task_wait` on a cancelled task gets the cancellation as
// its result; cancelled work otherwise never reaches the model.

/**
 * Which working tasks {@link cancelTasksStep} cancels. Idle tasks are not
 * working, so every selector leaves them available.
 */
export type TaskCancelSelector =
  /** Every working task: `session.cancel()`, a cancelled turn, or the session's end. */
  | { readonly kind: "all" }
  /** The working tasks one turn started: that turn failed, or a cancel named it after it ended. */
  | { readonly kind: "turn"; readonly turnId: string }
  /** The agent calls a workflow run awaits, once that run ends. */
  | { readonly kind: "workflow-run"; readonly runId: string };

/** The owner's table after cancelling tasks, and what it must send and publish. */
interface CancelledTasks {
  readonly table: TaskTable;
  readonly commands: readonly CommandEffect[];
  readonly events: readonly TaskSettledStreamEvent[];
}

type Session = { readonly state?: SessionStateMap };

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
  const initial = getTaskTable(durable);
  const selected = initial.records.filter(selectTasks(input.selector));
  const cancelled = cancelRecords(initial, selected, new Date().toISOString());
  if (cancelled.table === initial) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }
  await runCommands(cancelled.commands, await readContext(input.serializedContext));
  const applied = applyCancelled(
    durable,
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
  const cancelled = cancelRecords(table, selected, input.now);
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
 * Applies one model call that stops a detached task. A working task is
 * cancelled and never reports, except to a `task_wait` on it; a finished one
 * keeps its result. A call its turn still waits on is unknown, and a task
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
  if (isTerminalTaskStatus(record.status)) {
    return unchanged(cancelResult(request, { status: "already_finished" }));
  }
  const cancelled = cancelRecords(table, [record], input.now);
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

function selectTasks(selector: TaskCancelSelector): (record: TaskRecord) => boolean {
  switch (selector.kind) {
    case "all":
      return () => true;
    case "turn":
      return (record) => record.turnId === selector.turnId;
    case "workflow-run":
      return (record) => record.workflowCaller?.runId === selector.runId;
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
): CancelledTasks {
  if (runIds.size === 0) return { commands: [], events: [], table };
  return cancelRecords(
    table,
    table.records.filter(
      (record) => record.workflowCaller !== undefined && runIds.has(record.workflowCaller.runId),
    ),
    now,
  );
}

/** Cancels each working record, and the agent calls of each workflow run among them. */
function cancelRecords(
  table: TaskTable,
  selected: readonly TaskRecord[],
  now: string,
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
  const events: TaskSettledStreamEvent[] = [];
  for (const record of records) {
    if (isTerminalTaskStatus(record.status)) continue;
    const cancelled = cancelTask(next, record.id, now);
    next = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
    events.push(taskSettledEvent({ outcome: { status: "cancelled" }, record }));
  }
  return { commands, events, table: next };
}
