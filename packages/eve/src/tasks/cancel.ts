import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { TaskSettledStreamEvent } from "#protocol/message.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { MAX_TASK_CANCEL_IDS, readTaskCancelIds } from "#tasks/cancel-tool.js";
import { taskSettledEvent } from "#tasks/events.js";
import { commandEffects, readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { readTasks } from "#tasks/read.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderInvalidTaskCancelInput, type TaskCancelOutput } from "#tasks/render.js";
import { setTaskTable } from "#tasks/state.js";
import { cancelTask, findTask, type TaskTable } from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";

// Owner-side cancellation: record the outcome at once, ask each started child
// to stop, and never wait for it. The timer hard-stops a child that does not
// confirm in time.

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
  const initial = readTasks(durable);
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
  const update = {
    events: cancelled.events,
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
  };
  if (cancelled.table === initial) return { ...update, sessionState: input.sessionState };
  await runCommands(cancelled.commands, await readContext(input.serializedContext));
  return {
    ...update,
    sessionState: replaceDurableSessionSnapshot({
      session: setTaskTable(durable, cancelled.table),
      state: input.sessionState,
    }),
  };
}

/**
 * Applies one model call that stops background tasks. A working background
 * task is cancelled and never reports; a finished one keeps its result; any
 * other ID, including a call the turn is waiting on, is unknown. The caller
 * sends the commands and publishes the events.
 */
export function applyTaskCancelCall(
  table: TaskTable,
  request: RuntimeWorkflowTaskRequest,
  now: string,
): CancelledTasks & { readonly result: RuntimeToolResultActionResult } {
  const taskIds = readTaskCancelIds(request.input);
  if (taskIds === undefined) {
    return {
      commands: [],
      events: [],
      result: {
        callId: request.callId,
        isError: true,
        kind: "tool-result",
        output: {
          code: "INVALID_INPUT",
          message: renderInvalidTaskCancelInput(MAX_TASK_CANCEL_IDS),
        },
        toolName: request.toolName,
      },
      table,
    };
  }
  const output: { -readonly [K in keyof TaskCancelOutput]: string[] } = {
    alreadyFinished: [],
    cancelled: [],
    unknown: [],
  };
  const selected: TaskRecord[] = [];
  for (const taskId of new Set(taskIds)) {
    const record = findTask(table, taskId);
    if (record !== undefined && isTerminalTaskStatus(record.status)) {
      output.alreadyFinished.push(taskId);
    } else if (record !== undefined && isBackgroundWork(record)) {
      selected.push(record);
      output.cancelled.push(taskId);
    } else {
      output.unknown.push(taskId);
    }
  }
  return {
    ...cancelRecords(table, selected, now),
    result: { callId: request.callId, kind: "tool-result", output, toolName: request.toolName },
  };
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
