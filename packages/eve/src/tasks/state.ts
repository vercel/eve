import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionStateMap } from "#harness/types.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  nextTaskWakeAt,
  pruneTaskTable,
  readTaskTable,
  writeTaskTable,
  type TaskTable,
} from "#tasks/table.js";

// Read by the session workflow body, so it must not import Node.js built-ins.

/** The token a child session reports to: its owner's stable inbox. */
export function ownerInboxHookToken(ownerSessionId: string): string {
  return sessionInboxHookToken(sessionCommandHookToken(ownerSessionId));
}

/**
 * Reads the owner's task table. Unreadable records are left out; writes keep
 * them until the owner's deadline step reports each one as `STATE_LOST`.
 */
export function getTaskTable(session: { readonly state?: SessionStateMap }): TaskTable {
  return readTaskTable(session.state).table;
}

/** Writes the owner's task table, dropping records nothing will read again. */
export function setTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
  options?: { readonly dropLost?: boolean },
): T {
  return { ...session, state: writeTaskTable(session.state, pruneTaskTable(table), options) };
}

/** Session state key holding the owner's armed deadline timer. */
export const TASK_TIMER_STATE_KEY = "eve.taskTimer";

/** A wake time already in the past: the timer fires as soon as it starts. */
export const WAKE_NOW = new Date(0).toISOString();

/**
 * How long after its wake time an armed timer may take to signal. Past it,
 * the signal was lost (a failed timer run or an undeliverable signal) and
 * the owner arms a new timer instead of waiting forever.
 */
export const TASK_TIMER_GRACE_MS = 60_000;

/** The timer the owner last armed. It may already have fired. */
export interface ArmedTaskTimer {
  /** The owner run that armed it. A successor re-arms: the old timer may retire with its deployment. */
  readonly ownerRunId: string;
  readonly runId: string;
  readonly wakeAt: string;
}

export function readTaskTimer(state: SessionStateMap | undefined): ArmedTaskTimer | undefined {
  const value = state?.[TASK_TIMER_STATE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const { ownerRunId, runId, wakeAt } = value as {
    readonly ownerRunId?: unknown;
    readonly runId?: unknown;
    readonly wakeAt?: unknown;
  };
  return typeof ownerRunId === "string" &&
    typeof runId === "string" &&
    typeof wakeAt === "string" &&
    !Number.isNaN(Date.parse(wakeAt))
    ? { ownerRunId, runId, wakeAt }
    : undefined;
}

export function writeTaskTimer(
  state: SessionStateMap | undefined,
  timer: ArmedTaskTimer | undefined,
): SessionStateMap | undefined {
  if (timer !== undefined) return { ...state, [TASK_TIMER_STATE_KEY]: { ...timer } };
  if (state?.[TASK_TIMER_STATE_KEY] === undefined) return state;
  const next = { ...state };
  delete next[TASK_TIMER_STATE_KEY];
  return Object.keys(next).length === 0 ? undefined : next;
}

/** What the owner does with its timer after a table change. */
export type TaskTimerPlan =
  | { readonly kind: "keep" }
  | { readonly kind: "arm"; readonly wakeAt: string }
  /** Nothing is due any more: stop the armed timer so a settled session is not woken. */
  | { readonly kind: "cancel" };

/**
 * Decides whether the owner arms, keeps, or cancels its timer. The armed
 * timer is kept only when this owner run armed it, it fires no later than
 * the table needs, and its signal is not overdue. An unreadable record wakes
 * the owner at once: the deadline step reports it as `STATE_LOST` and removes
 * it, so it cannot block handoff. A wake time in the past is armed for `nowMs`.
 */
export function planTaskTimer(
  state: SessionStateMap | undefined,
  current: { readonly nowMs: number; readonly ownerRunId: string },
): TaskTimerPlan {
  const { lost, table } = readTaskTable(state);
  const needed = lost.length > 0 ? WAKE_NOW : nextTaskWakeAt(table);
  const armed = readTaskTimer(state);
  if (needed === undefined) return armed === undefined ? { kind: "keep" } : { kind: "cancel" };
  const wakeAtMs = Math.max(Date.parse(needed), current.nowMs);
  if (
    armed !== undefined &&
    armed.ownerRunId === current.ownerRunId &&
    Date.parse(armed.wakeAt) <= wakeAtMs &&
    Date.parse(armed.wakeAt) + TASK_TIMER_GRACE_MS >= current.nowMs
  ) {
    return { kind: "keep" };
  }
  return { kind: "arm", wakeAt: new Date(wakeAtMs).toISOString() };
}

/** Session state key holding the owner's remote callback alias. */
export const TASK_CALLBACK_ALIAS_STATE_KEY = "eve.taskCallbackAlias";

/** Prefix of every remote callback alias. The callback route accepts only these. */
export const TASK_CALLBACK_ALIAS_PREFIX = "eve:task-callback:";

/**
 * The owner's unguessable alias that remote children call back on. It is
 * minted once, before any remote child starts, and claimed with the
 * session's other hooks so it survives retries and handoff.
 */
export function readTaskCallbackAlias(state: SessionStateMap | undefined): string | undefined {
  const value = state?.[TASK_CALLBACK_ALIAS_STATE_KEY];
  return typeof value === "string" && value.startsWith(TASK_CALLBACK_ALIAS_PREFIX)
    ? value
    : undefined;
}

/** Whether any task the owner started is still working. */
export function hasWorkingTasks(session: { readonly state?: SessionStateMap }): boolean {
  return getTaskTable(session).records.some(
    (record) => record.status === "working" || record.status === "input_required",
  );
}

/** The identity a workflow tool run reports with. */
export interface WorkflowRunReference {
  readonly callId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly turnId: string;
}

/**
 * The workflow task a run reports for. It matches by task, not run: a
 * retried start can leave a second run, but only the run that claimed the
 * task's command hook executes the body and reports. A task the owner
 * stopped still matches until the run confirms it.
 */
export function findWorkflowTask(
  table: TaskTable,
  from: WorkflowRunReference,
): TaskRecord | undefined {
  return table.records.find(
    (record) =>
      record.kind === "workflow" &&
      record.id === from.taskId &&
      record.callId === from.callId &&
      record.turnId === from.turnId &&
      record.name === from.toolName &&
      record.child?.kind === "workflow" &&
      (!isTerminalTaskStatus(record.status) || record.cancelConfirmBy !== undefined),
  );
}
