import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import type { SessionStateMap } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { deriveTaskId } from "#tasks/ids.js";
import { dropLegacyTaskState, readLegacyTaskLosses } from "#tasks/legacy.js";
import {
  isTerminalTaskStatus,
  type ChildAddress,
  type TaskCommand,
  type TaskError,
  type TaskKind,
  type TaskMessage,
  type TaskMode,
  type TaskOutcome,
} from "#tasks/protocol.js";
import {
  decodeTaskRecord,
  isOpenResumableTask,
  TASK_RECORD_VERSION,
  type RecoveredTaskFields,
  type TaskRecord,
} from "#tasks/record.js";
import { renderLastStatus } from "#tasks/render.js";
import {
  adoptStartedGeneration,
  continueWithSends,
  endTask,
  readSendSeqs,
  withoutRead,
} from "#tasks/table-generations.js";

/** Session state key holding the owner's task records. */
export const TASK_TABLE_STATE_KEY = "eve.taskTable";

/**
 * How long a cancelled agent has to confirm before the owner hard-stops it:
 * the same cleanup window a workflow run gives its own body.
 */
export const TASK_CANCEL_CONFIRM_MS = WORKFLOW_CANCELLATION_CLEANUP_MS;

/**
 * A cancelled workflow run unwinds for its full cleanup window before it
 * reports; the margin keeps the hard stop from racing that report.
 */
export const WORKFLOW_TASK_CANCEL_CONFIRM_MS = WORKFLOW_CANCELLATION_CLEANUP_MS + 5_000;

/** Default time limit for one agent generation, in active (non-waiting) time. */
export const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60_000;

/** Working detached tasks one session may hold; a start over the cap fails `TOO_MANY_TASKS`. */
export const MAX_WORKING_TASKS = 20;

/**
 * Sends one task may hold unread, queued in its child or held for a child
 * still starting. A send past the cap fails `TASK_BUSY`, so neither the
 * record nor the child's queue grows without bound.
 */
export const MAX_UNREAD_SENDS = 20;

const MAX_DATE_MS = 8.64e15;

declare const TASK_TABLE: unique symbol;

/**
 * The owner's task records. Only this module's transitions produce a table,
 * so no other code can write a record into one.
 */
export interface TaskTable {
  readonly records: readonly TaskRecord[];
  readonly [TASK_TABLE]: true;
}

/**
 * A record that could not be decoded. Writes keep it until the owner's
 * deadline step reports it as `STATE_LOST` and removes it.
 */
export type LostTask = RecoveredTaskFields & {
  readonly reason: string;
  /** The stored value, kept by writes until the loss is reported. */
  readonly value?: unknown;
  /** A second record with a readable task's ID; it is dropped, not reported. */
  readonly duplicate?: true;
};

/**
 * Whether a lost record stands for a result someone still waits on. A
 * record whose result already reached history is dropped silently.
 */
export function isReportedLoss(
  lost: LostTask,
): lost is LostTask & { readonly id: string; readonly name: string } {
  return (
    lost.id !== undefined &&
    lost.name !== undefined &&
    lost.duplicate !== true &&
    lost.delivered !== true
  );
}

/** What the owner must do after a table transition. Effects are never persisted. */
export type TaskEffect =
  | {
      /** The first terminal outcome of a generation the owner did not cancel. */
      readonly kind: "settled";
      readonly record: TaskRecord;
      readonly outcome: TaskOutcome;
      readonly usage?: TokenUsage;
    }
  | {
      readonly kind: "send";
      readonly record: TaskRecord;
      readonly commands: readonly TaskCommand[];
    }
  | {
      /** A resumable task started its next generation, for the send `record.callId` names. */
      readonly kind: "started";
      readonly record: TaskRecord;
    }
  | {
      /**
       * A generation the owner cancelled with its task's work before it began:
       * a send `task_cancel` stopped. It starts and settles `cancelled` at
       * once, and nothing reaches the model.
       */
      readonly kind: "cancelled";
      readonly record: TaskRecord;
    }
  | {
      /** The task stopped taking input, after its last generation settled. */
      readonly kind: "ended";
      readonly record: TaskRecord;
    }
  | {
      /**
       * A child the owner cancelled confirmed it stopped. Nothing reaches the
       * model, but its usage still counts.
       */
      readonly kind: "confirmed";
      readonly record: TaskRecord;
      readonly usage?: TokenUsage;
    }
  | {
      /**
       * A stopped child did not confirm within its window. `child` is the run
       * to hard-stop, which the record no longer names: a stopped run takes no
       * more work. A remote child already has the cancel request, and an
       * unstarted one has nothing to stop.
       */
      readonly kind: "unconfirmed";
      readonly record: TaskRecord;
      readonly child?: Extract<ChildAddress, { readonly kind: "local" | "workflow" }>;
    };

export interface TaskTransition {
  readonly table: TaskTable;
  readonly effects: readonly TaskEffect[];
}

function toTable(records: readonly TaskRecord[]): TaskTable {
  return { records } as TaskTable;
}

const EMPTY_TABLE = toTable([]);

/**
 * Reads the table, decoding each record on its own so one bad record never
 * fails the session. Runs an earlier release left working are lost too.
 */
export function readTaskTable(state: SessionStateMap | undefined): {
  readonly table: TaskTable;
  readonly lost: readonly LostTask[];
} {
  const legacy = readLegacyTaskLosses(state);
  const raw = state?.[TASK_TABLE_STATE_KEY];
  if (raw === undefined) return { lost: legacy, table: EMPTY_TABLE };
  const values =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { records?: unknown }).records)
      ? Array.from((raw as { records: unknown[] }).records)
      : undefined;
  if (values === undefined) {
    return { lost: [{ reason: "unreadable task table" }, ...legacy], table: EMPTY_TABLE };
  }
  const records: TaskRecord[] = [];
  const lost: LostTask[] = [...legacy];
  const ids = new Set<string>();
  for (const value of values) {
    const decoded = decodeTaskRecord(value);
    if (!decoded.ok) {
      const { ok: _ok, ...loss } = decoded;
      lost.push({ ...loss, value });
      continue;
    }
    if (ids.has(decoded.record.id)) {
      lost.push({
        duplicate: true,
        id: decoded.record.id,
        name: decoded.record.name,
        reason: "duplicate id",
      });
      continue;
    }
    ids.add(decoded.record.id);
    records.push(decoded.record);
  }
  return { lost, table: toTable(records) };
}

/**
 * Writes the table. Unreadable records already in `state` are kept, so no
 * write loses a task silently; `dropLost` removes them, and an earlier
 * release's registry, once the owner has reported each loss.
 */
export function writeTaskTable(
  current: SessionStateMap | undefined,
  table: TaskTable,
  options: { readonly dropLost?: boolean } = {},
): SessionStateMap | undefined {
  const state = options.dropLost === true ? dropLegacyTaskState(current) : current;
  const kept =
    options.dropLost === true
      ? []
      : readTaskTable(state).lost.flatMap((lost) =>
          lost.value === undefined || lost.duplicate === true ? [] : [lost.value],
        );
  const records = [...table.records, ...kept];
  if (records.length === 0) {
    if (state?.[TASK_TABLE_STATE_KEY] === undefined) return state;
    const next = { ...state };
    delete next[TASK_TABLE_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return { ...state, [TASK_TABLE_STATE_KEY]: { records } };
}

export function findTask(table: TaskTable, taskId: string): TaskRecord | undefined {
  return table.records.find((record) => record.id === taskId);
}

export type StartTaskResult =
  | { readonly kind: "started"; readonly table: TaskTable; readonly record: TaskRecord }
  /** A replayed call whose record already exists; its side effects already ran. */
  | { readonly kind: "existing"; readonly record: TaskRecord };

export interface StartTaskInput {
  readonly callId: string;
  readonly turnId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly kind: TaskKind;
  readonly mode: TaskMode;
  readonly now: string;
  readonly nodeId?: string;
  /** Per-call time limit. `false` leaves only the session lifetime. */
  readonly timeoutMs?: number | false;
  readonly creator?: JsonObject;
  /** The task takes more input by `taskId`. */
  readonly resumable?: boolean;
  readonly workflowCaller?: TaskRecord["workflowCaller"];
}

/**
 * Records the intent to start a task. It is idempotent by call, so a replayed
 * model step returns the record it already committed. No child starts here.
 */
export function startTask(table: TaskTable, input: StartTaskInput): StartTaskResult {
  const existing = table.records.find(
    (record) => record.callId === input.callId && record.turnId === input.turnId,
  );
  if (existing !== undefined) return { kind: "existing", record: existing };

  const { deadlineAt, timeoutMs } = generationDeadline(input.timeoutMs, input.now);
  const id = deriveTaskId({
    callId: input.callId,
    name: input.name,
    ownerId: input.ownerId,
    taken: (candidate) => findTask(table, candidate) !== undefined,
    turnId: input.turnId,
  });
  const record: TaskRecord = withoutUndefined({
    callId: input.callId,
    creator: input.creator,
    deadlineAt,
    delivered: false,
    generation: 1,
    id,
    kind: input.kind,
    mode: input.mode,
    name: input.name,
    nodeId: input.nodeId,
    resumable: input.resumable === true ? true : undefined,
    startedAt: input.now,
    status: "working",
    timeoutMs,
    turnId: input.turnId,
    v: TASK_RECORD_VERSION,
    workflowCaller: input.workflowCaller,
  });
  return { kind: "started", record, table: toTable([...table.records, record]) };
}

/**
 * Applies one child or timer message. The first terminal outcome of a
 * generation wins; duplicates, stale generations, and unknown tasks are no-ops.
 */
export function applyTaskMessage(
  table: TaskTable,
  message: Exclude<TaskMessage, { kind: "task.deadline" }>,
  now: string,
): TaskTransition {
  const record = findTask(table, message.taskId);
  if (message.kind === "task.ended") {
    return record === undefined || record.ended === true
      ? { effects: [], table }
      : endTask(table, record, now, message.unread);
  }
  // A run's report of a generation it started for a send, checked against the owner's own.
  if (message.kind === "task.started" && message.send !== undefined) {
    return record === undefined
      ? { effects: [], table }
      : adoptStartedGeneration(table, record, message.generation, message.send, now);
  }
  if (record === undefined || record.generation !== message.generation) {
    return { effects: [], table };
  }
  switch (message.kind) {
    case "task.started": {
      if (record.child !== undefined || message.child === undefined) return { effects: [], table };
      const pending = record.pendingCommands ?? [];
      const next = withoutUndefined({
        ...record,
        child: message.child,
        pendingCommands: undefined,
      });
      return {
        effects: pending.length === 0 ? [] : [{ commands: pending, kind: "send", record: next }],
        table: replaceRecord(table, next),
      };
    }
    case "task.input": {
      // The clock rule: it stops while any surfaced request waits on a person.
      if (isTerminalTaskStatus(record.status)) return { effects: [], table };
      const waiting = message.input.length > 0;
      const next = withoutUndefined<TaskRecord>({
        ...record,
        clockStoppedAt: waiting ? (record.clockStoppedAt ?? now) : undefined,
        deadlineAt: waiting ? record.deadlineAt : resumeDeadline(record, now),
        input: waiting ? message.input : undefined,
        status: waiting ? "input_required" : "working",
      });
      return { effects: [], table: replaceRecord(table, next) };
    }
    case "task.settled": {
      // A repeat of an answer already applied, even one to an earlier
      // generation of the same call, settles nothing.
      if (
        message.answer !== undefined &&
        record.answerSeq !== undefined &&
        message.answer <= record.answerSeq
      ) {
        return { effects: [], table };
      }
      const answerSeq = message.answer ?? record.answerSeq;
      // Sends the child read during this generation, and the one that started it.
      const read = withoutRead(record, readSendSeqs(record, message));
      const effects: TaskEffect[] = [];
      let next: TaskRecord;
      if (isTerminalTaskStatus(record.status) && record.cancelConfirmBy !== undefined) {
        // A child the owner stopped (cancelled or timed out) confirms here.
        next = withoutUndefined({ ...record, ...read, answerSeq, cancelConfirmBy: undefined });
        effects.push(
          withoutUndefined({ kind: "confirmed" as const, record: next, usage: message.usage }),
        );
      } else if (isTerminalTaskStatus(record.status)) {
        return { effects: [], table };
      } else {
        next = withoutUndefined({ ...settleRecord(record, message.outcome), ...read, answerSeq });
        effects.push(
          withoutUndefined({
            kind: "settled" as const,
            outcome: message.outcome,
            record: next,
            usage: message.usage,
          }),
        );
      }
      const settled = replaceRecord(table, next);
      // An agent whose session ended with this answer takes no more input.
      const continued =
        message.childEnded === true
          ? endTask(settled, next, now)
          : continueWithSends(settled, next, now);
      return { effects: [...effects, ...continued.effects], table: continued.table };
    }
  }
}

/** Settles a working task failed with `error`, such as a timeout, and asks its child to stop. */
export function failTask(
  table: TaskTable,
  taskId: string,
  now: string,
  error: TaskError,
): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || isTerminalTaskStatus(record.status)) return { effects: [], table };
  const outcome: TaskOutcome = { error, status: "failed" };
  // The child drops the input queued for work it stops, as for a cancel.
  const failed = withoutUndefined({
    ...settleRecord(record, outcome),
    cancelConfirmBy: cancelConfirmBy(record, now),
    sends: record.sends?.map((send) => ({ ...send, cancelled: true as const })),
  });
  const commanded = issueCommand(replaceRecord(table, failed), failed, { kind: "cancel" });
  return {
    effects: [{ kind: "settled", outcome, record: failed }, ...commanded.effects],
    table: commanded.table,
  };
}

/** Detached generations still working, which count toward {@link MAX_WORKING_TASKS}. */
export function workingDetachedTaskIds(table: TaskTable): readonly string[] {
  return table.records
    .filter(
      (record) =>
        record.mode === "detached" &&
        record.workflowCaller === undefined &&
        (record.status === "working" || record.status === "input_required"),
    )
    .map((record) => record.id);
}

/**
 * Records cancellation immediately and asks the child to stop: the working
 * generation, and every send queued for the task, whose generations settle
 * `cancelled` as they come up. The child's own `cancelled` report is
 * dropped as a duplicate, so it never wakes the model.
 */
export function cancelTask(table: TaskTable, taskId: string, now: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || !hasCancellableWork(record)) return { effects: [], table };
  const sends = record.sends?.map((send) => ({ ...send, cancelled: true as const }));
  const cancelled = isTerminalTaskStatus(record.status)
    ? { ...record, sends }
    : withoutUndefined({
        ...record,
        cancelConfirmBy: cancelConfirmBy(record, now),
        clockStoppedAt: undefined,
        deadlineAt: undefined,
        // The owner already knows the outcome; there is nothing left to deliver.
        delivered: true,
        input: undefined,
        lastStatus: renderLastStatus({ status: "cancelled" }),
        sends,
        status: "cancelled" as const,
      });
  return issueCommand(replaceRecord(table, cancelled), cancelled, { kind: "cancel" });
}

/** A working generation, or a send queued for the task that no cancel has stopped yet. */
export function hasCancellableWork(record: TaskRecord): boolean {
  return (
    record.ended !== true &&
    (!isTerminalTaskStatus(record.status) ||
      record.sends?.some((send) => send.cancelled !== true) === true)
  );
}

/** Marks the current generation's result as present in history. */
export function markTaskDelivered(table: TaskTable, taskId: string, generation: number): TaskTable {
  const record = findTask(table, taskId);
  if (record === undefined || record.generation !== generation || record.delivered) return table;
  return replaceRecord(table, { ...record, delivered: true });
}

/**
 * Points the task at the `task_wait` call that takes its current
 * generation's result, or clears the pointer.
 */
export function setTaskWait(
  table: TaskTable,
  taskId: string,
  wait: TaskRecord["wait"] | undefined,
): TaskTable {
  const record = findTask(table, taskId);
  if (record === undefined || record.wait === wait) return table;
  return replaceRecord(table, withoutUndefined({ ...record, wait }));
}

/**
 * Drops finished tasks whose results reached history: non-resumable tasks,
 * and resumable ones that ended or whose child never started. Idle tasks stay
 * listed. No window is kept for late duplicates: every report names the task
 * it answers, so one that matches no record is dropped and settles nothing.
 */
export function pruneTaskTable(table: TaskTable): TaskTable {
  const records = table.records.filter((record) => {
    if (!isTerminalTaskStatus(record.status) || !record.delivered) return true;
    if (record.cancelConfirmBy !== undefined || record.sends !== undefined) return true;
    return isOpenResumableTask(record) && record.child !== undefined;
  });
  return records.length === table.records.length ? table : toTable(records);
}

/** Sends a command to a started child, or holds it until the child starts. For `tasks/table*.ts` only. */
export function issueCommand(
  table: TaskTable,
  record: TaskRecord,
  command: TaskCommand,
): TaskTransition {
  if (record.child !== undefined) {
    return { effects: [{ commands: [command], kind: "send", record }], table };
  }
  const next = { ...record, pendingCommands: [...(record.pendingCommands ?? []), command] };
  return { effects: [], table: replaceRecord(table, next) };
}

/** For `tasks/table*.ts` only. */
export function settleRecord(record: TaskRecord, outcome: TaskOutcome): TaskRecord {
  return withoutUndefined({
    ...record,
    clockStoppedAt: undefined,
    deadlineAt: undefined,
    input: undefined,
    lastStatus: renderLastStatus(outcome),
    status: outcome.status,
  });
}

/**
 * One generation's deadline and limit. `false` or no limit leaves only the
 * session lifetime, and so does a limit past the last representable date.
 */
export function generationDeadline(
  timeoutMs: number | false | undefined,
  now: string,
): { readonly deadlineAt?: string; readonly timeoutMs?: number } {
  if (timeoutMs === false || timeoutMs === undefined) return {};
  const deadlineMs = Date.parse(now) + timeoutMs;
  return deadlineMs > MAX_DATE_MS
    ? {}
    : { deadlineAt: new Date(deadlineMs).toISOString(), timeoutMs };
}

/** For `tasks/table*.ts` only. */
export function cancelConfirmBy(record: TaskRecord, now: string): string {
  const window =
    record.kind === "workflow" ? WORKFLOW_TASK_CANCEL_CONFIRM_MS : TASK_CANCEL_CONFIRM_MS;
  return new Date(Date.parse(now) + window).toISOString();
}

/** Extends the deadline by the time spent waiting on a human. */
function resumeDeadline(record: TaskRecord, now: string): string | undefined {
  if (record.deadlineAt === undefined || record.clockStoppedAt === undefined) {
    return record.deadlineAt;
  }
  const waited = Math.max(0, Date.parse(now) - Date.parse(record.clockStoppedAt));
  return new Date(Date.parse(record.deadlineAt) + waited).toISOString();
}

/** Writes one record into the table. For `tasks/table*.ts` only. */
export function replaceRecord(table: TaskTable, record: TaskRecord): TaskTable {
  const index = table.records.findIndex((candidate) => candidate.id === record.id);
  if (index < 0) return toTable([...table.records, record]);
  const records = [...table.records];
  records[index] = record;
  return toTable(records);
}

/** For `tasks/table*.ts` only. */
export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
