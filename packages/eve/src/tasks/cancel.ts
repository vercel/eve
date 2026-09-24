import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
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
import { TASK_CANCEL_INVALID_INPUT_MESSAGE, type TaskCancelOutput } from "#tasks/render.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { cancelTask, type TaskTable } from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";
import { takeLiveWait } from "#tasks/wait.js";

// Owner-side cancellation: record the outcome at once, ask each started child
// to stop, and never wait for it. The timer hard-stops a child that does not
// confirm in time. A `task_wait` on a cancelled task gets the cancellation as
// its result; cancelled work otherwise never reaches the model.

/** Which working tasks {@link cancelTasksStep} cancels. */
export type TaskCancelSelector =
  /** The waited tasks of the turn the session is running or parked in. */
  | { readonly kind: "active-turn" }
  /** Every working task: the session ends, or its delegated caller cancels it. */
  | { readonly kind: "all" }
  /**
   * Every working task no caller waits on. The calls a turn waits on are
   * cancelled with that turn, so a turn that keeps running never waits on a
   * cancelled call.
   */
  | { readonly kind: "background" }
  /** One background task. A call its turn waits on is cancelled with that turn. */
  | { readonly kind: "task"; readonly taskId: string }
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
  const selected = initial.records.filter(
    selectTasks(
      input.selector,
      initial,
      () =>
        getPendingCoordinationBatch(durable.state)?.event.turnId ??
        activeTurnId(input.sessionState.emissionState),
    ),
  );
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
 * Applies one model call that stops a background task. A working task is
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

function selectTasks(
  selector: TaskCancelSelector,
  table: TaskTable,
  turnId: () => string,
): (record: TaskRecord) => boolean {
  switch (selector.kind) {
    case "all":
      return () => true;
    case "background":
      return isBackgroundWork;
    case "task":
      return (record) => record.id === selector.taskId && isBackgroundWork(record);
    case "workflow-run":
      return (record) => record.workflowCaller?.runId === selector.runId;
    case "active-turn": {
      const activeTurn = turnId();
      // A background run's own agent calls belong to that run, not to any turn.
      const backgroundRuns = new Set(
        table.records.flatMap((record) =>
          record.mode === "background" && record.child?.kind === "workflow"
            ? [record.child.runId]
            : [],
        ),
      );
      return (record) =>
        record.turnId === activeTurn &&
        record.mode === "foreground" &&
        !backgroundRuns.has(record.workflowCaller?.runId ?? "");
    }
  }
}

/** A task no caller waits on: a background call, or one that detached. */
function isBackgroundWork(record: TaskRecord): boolean {
  return record.mode === "background" && record.workflowCaller === undefined;
}

function cancelRecords(
  table: TaskTable,
  records: readonly TaskRecord[],
  now: string,
): CancelledTasks {
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
