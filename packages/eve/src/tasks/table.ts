import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { deriveTaskId } from "#tasks/ids.js";
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
  TASK_RECORD_VERSION,
  type RecoveredTaskFields,
  type TaskRecord,
} from "#tasks/record.js";
import {
  renderAgentMismatch,
  renderAgentUnreachable,
  renderLastStatus,
  renderNotAnAgent,
  renderTimedOut,
  renderUnknownAgent,
} from "#tasks/render.js";

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
      readonly kind: "input";
      readonly record: TaskRecord;
      readonly requests: readonly InputRequest[];
    }
  | {
      /**
       * An agent answered before steering messages reached it, and runs them
       * as its next turn for the same call: `record` is that new background
       * generation, already working.
       */
      readonly kind: "continued";
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

/** Reads the table, decoding each record on its own so one bad record never fails the session. */
export function readTaskTable(state: SessionStateMap | undefined): {
  readonly table: TaskTable;
  readonly lost: readonly LostTask[];
} {
  const raw = state?.[TASK_TABLE_STATE_KEY];
  if (raw === undefined) return { lost: [], table: EMPTY_TABLE };
  const values =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { records?: unknown }).records)
      ? Array.from((raw as { records: unknown[] }).records)
      : undefined;
  if (values === undefined) {
    return { lost: [{ reason: "unreadable task table" }], table: EMPTY_TABLE };
  }
  const records: TaskRecord[] = [];
  const lost: LostTask[] = [];
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
 * write loses a task silently; `dropLost` removes them once the owner has
 * reported each loss.
 */
export function writeTaskTable(
  state: SessionStateMap | undefined,
  table: TaskTable,
  options: { readonly dropLost?: boolean } = {},
): SessionStateMap | undefined {
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
  | { readonly kind: "existing"; readonly record: TaskRecord }
  | {
      /** The call named a working agent; the owner decides whether its message may join. */
      readonly kind: "steered";
      readonly record: TaskRecord;
    }
  | { readonly kind: "rejected"; readonly error: TaskError };

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
  /** Continue this agent instead of starting a new one. */
  readonly agentId?: string;
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

  const deadlineMs =
    input.timeoutMs === false || input.timeoutMs === undefined
      ? undefined
      : Date.parse(input.now) + input.timeoutMs;
  // A limit past the last representable date can never expire before the session does.
  const deadlineAt =
    deadlineMs === undefined || deadlineMs > MAX_DATE_MS
      ? undefined
      : new Date(deadlineMs).toISOString();

  if (input.agentId !== undefined) {
    const agent = findTask(table, input.agentId);
    if (agent === undefined) {
      return {
        kind: "rejected",
        error: { code: "UNKNOWN_AGENT", message: renderUnknownAgent(input.agentId) },
      };
    }
    if (agent.kind !== "agent") {
      return {
        kind: "rejected",
        error: { code: "UNKNOWN_AGENT", message: renderNotAnAgent(input.agentId) },
      };
    }
    if (
      agent.name !== input.name ||
      (input.nodeId !== undefined && agent.nodeId !== input.nodeId)
    ) {
      return {
        kind: "rejected",
        error: { code: "AGENT_MISMATCH", message: renderAgentMismatch(agent) },
      };
    }
    if (isTerminalTaskStatus(agent.status) && agent.child === undefined) {
      return {
        kind: "rejected",
        error: { code: "AGENT_UNREACHABLE", message: renderAgentUnreachable(agent.id, "ended") },
      };
    }
    if (!isTerminalTaskStatus(agent.status)) return { kind: "steered", record: agent };
    const next: TaskRecord = withoutUndefined({
      ...agent,
      callId: input.callId,
      cancelConfirmBy: undefined,
      clockStoppedAt: undefined,
      creator: input.creator ?? agent.creator,
      deadlineAt,
      delivered: false,
      detachGroup: undefined,
      generation: agent.generation + 1,
      mode: input.mode,
      pendingCommands: undefined,
      startedAt: input.now,
      status: "working",
      steers: undefined,
      turnId: input.turnId,
      workflowCaller: input.workflowCaller,
    });
    return { kind: "started", record: next, table: replace(table, next) };
  }

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
    startedAt: input.now,
    status: "working",
    turnId: input.turnId,
    v: TASK_RECORD_VERSION,
    workflowCaller: input.workflowCaller,
  });
  return { kind: "started", record, table: toTable([...table.records, record]) };
}

/**
 * Sends a working agent a message that joins its current generation. A local
 * agent reports how many such messages reached it when it answers, so each
 * one sent to it is counted; a remote agent reports none.
 */
export function steerTask(
  table: TaskTable,
  taskId: string,
  command: Extract<TaskCommand, { readonly kind: "message" }>,
): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || isTerminalTaskStatus(record.status)) return { effects: [], table };
  const counted =
    record.child?.kind === "remote" ? record : { ...record, steers: (record.steers ?? 0) + 1 };
  return issueCommand(replace(table, counted), counted, command);
}

/** Stops counting a steering message that could not be delivered, so the owner does not wait for it. */
export function withdrawSteer(table: TaskTable, taskId: string, generation: number): TaskTable {
  const record = findTask(table, taskId);
  if (record?.generation !== generation || record.steers === undefined) return table;
  return replace(
    table,
    withoutUndefined({ ...record, steers: record.steers > 1 ? record.steers - 1 : undefined }),
  );
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
  if (record === undefined || record.generation !== message.generation) {
    return { effects: [], table };
  }
  switch (message.kind) {
    case "task.started": {
      if (record.child !== undefined) return { effects: [], table };
      const pending = record.pendingCommands ?? [];
      const next = withoutUndefined({
        ...record,
        child: message.child,
        pendingCommands: undefined,
      });
      return {
        effects: pending.length === 0 ? [] : [{ commands: pending, kind: "send", record: next }],
        table: replace(table, next),
      };
    }
    case "task.input": {
      if (isTerminalTaskStatus(record.status)) return { effects: [], table };
      if (message.seq <= (record.inputSeq ?? -1)) return { effects: [], table };
      const waiting = message.requests.length > 0;
      const next = withoutUndefined<TaskRecord>({
        ...record,
        clockStoppedAt: waiting ? (record.clockStoppedAt ?? now) : undefined,
        deadlineAt: waiting ? record.deadlineAt : resumeDeadline(record, now),
        inputSeq: message.seq,
        status: waiting ? "input_required" : "working",
      });
      return {
        effects: [{ kind: "input", record: next, requests: message.requests }],
        table: replace(table, next),
      };
    }
    case "task.settled": {
      // A child the owner stopped (cancelled or timed out) confirms here.
      if (isTerminalTaskStatus(record.status) && record.cancelConfirmBy !== undefined) {
        const confirmed = withoutUndefined({
          ...record,
          cancelConfirmBy: undefined,
          child: message.childEnded === true ? undefined : record.child,
        });
        return {
          effects: [
            withoutUndefined({
              kind: "confirmed" as const,
              record: confirmed,
              usage: message.usage,
            }),
          ],
          table: replace(table, confirmed),
        };
      }
      if (isTerminalTaskStatus(record.status)) return { effects: [], table };
      const settled = settleRecord(record, message.outcome);
      const next =
        message.childEnded === true ? withoutUndefined({ ...settled, child: undefined }) : settled;
      const effects: TaskEffect[] = [
        withoutUndefined({
          kind: "settled" as const,
          outcome: message.outcome,
          record: next,
          usage: message.usage,
        }),
      ];
      const missed = (record.steers ?? 0) - (message.steers ?? 0);
      if (missed <= 0 || message.childEnded === true) {
        return { effects, table: replace(table, next) };
      }
      // The agent answered before these messages reached it. It runs them as
      // its next turn for the same call, so they become its next generation.
      const continued = continueAfterMissedSteers(record, next, missed, now);
      effects.push({ kind: "continued", record: continued });
      return { effects, table: replace(table, continued) };
    }
  }
}

/**
 * Records cancellation immediately and asks the child to stop. The child's
 * own `cancelled` report is dropped as a duplicate, so it never wakes the model.
 */
export function cancelTask(table: TaskTable, taskId: string, now: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || isTerminalTaskStatus(record.status)) return { effects: [], table };
  const cancelled = withoutUndefined({
    ...record,
    cancelConfirmBy: cancelConfirmBy(record, now),
    clockStoppedAt: undefined,
    deadlineAt: undefined,
    // The owner already knows the outcome; there is nothing left to deliver.
    delivered: true,
    lastStatus: renderLastStatus({ status: "cancelled" }),
    status: "cancelled" as const,
  });
  return issueCommand(replace(table, cancelled), cancelled, { kind: "cancel" });
}

/** Settles a task that did not finish in time and asks its child to stop. */
export function timeOutTask(table: TaskTable, taskId: string, now: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || isTerminalTaskStatus(record.status)) return { effects: [], table };
  const outcome: TaskOutcome = {
    error: { code: "TIMED_OUT", message: renderTimedOut(record.kind) },
    status: "failed",
  };
  const timedOut = withoutUndefined({
    ...settleRecord(record, outcome),
    cancelConfirmBy: cancelConfirmBy(record, now),
  });
  const commanded = issueCommand(replace(table, timedOut), timedOut, { kind: "cancel" });
  return {
    effects: [{ kind: "settled", outcome, record: timedOut }, ...commanded.effects],
    table: commanded.table,
  };
}

/**
 * Evaluates deadlines. A due working task times out and its child is asked
 * to stop; a stopped task past its confirmation window is reported
 * unconfirmed, with the run to hard-stop when the owner can stop it.
 */
export function evaluateTaskDeadlines(table: TaskTable, now: string): TaskTransition {
  const nowMs = Date.parse(now);
  const effects: TaskEffect[] = [];
  let next = table;
  for (const record of table.records) {
    if (
      !isTerminalTaskStatus(record.status) &&
      record.clockStoppedAt === undefined &&
      record.deadlineAt !== undefined &&
      Date.parse(record.deadlineAt) <= nowMs
    ) {
      const timedOut = timeOutTask(next, record.id, now);
      next = timedOut.table;
      effects.push(...timedOut.effects);
      continue;
    }
    if (record.cancelConfirmBy !== undefined && Date.parse(record.cancelConfirmBy) <= nowMs) {
      // A remote child already has the cancel request; there is nothing more to stop.
      const child = record.child?.kind === "remote" ? undefined : record.child;
      const confirmed = withoutUndefined({
        ...record,
        cancelConfirmBy: undefined,
        child: child === undefined ? record.child : undefined,
      });
      next = replace(next, confirmed);
      effects.push(
        child === undefined
          ? { kind: "unconfirmed", record: confirmed }
          : { child, kind: "unconfirmed", record: confirmed },
      );
    }
  }
  return { effects, table: next };
}

/** The earliest time the owner must re-evaluate deadlines, if any. */
export function nextTaskWakeAt(table: TaskTable): string | undefined {
  let earliest: number | undefined;
  for (const record of table.records) {
    const candidates = [
      !isTerminalTaskStatus(record.status) && record.clockStoppedAt === undefined
        ? record.deadlineAt
        : undefined,
      record.cancelConfirmBy,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      const ms = Date.parse(candidate);
      if (earliest === undefined || ms < earliest) earliest = ms;
    }
  }
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

/** Marks the current generation's result as present in history. */
export function markTaskDelivered(table: TaskTable, taskId: string, generation: number): TaskTable {
  const record = findTask(table, taskId);
  if (record === undefined || record.generation !== generation || record.delivered) return table;
  return replace(table, { ...record, delivered: true });
}

/**
 * Moves waited tasks to the background. Tasks sharing `detachGroup` deliver
 * their results together; without one, each result is delivered on its own.
 */
export function detachTasks(
  table: TaskTable,
  taskIds: readonly string[],
  detachGroup?: string,
): TaskTable {
  let next = table;
  for (const taskId of taskIds) {
    const record = findTask(next, taskId);
    if (record === undefined || record.mode === "background") continue;
    next = replace(next, withoutUndefined({ ...record, detachGroup, mode: "background" as const }));
  }
  return next;
}

/**
 * Drops finished workflow tasks whose results reached history, and agents
 * whose session can no longer be continued. Idle agents stay listed.
 */
export function pruneTaskTable(table: TaskTable): TaskTable {
  const records = table.records.filter((record) => {
    if (!isTerminalTaskStatus(record.status) || !record.delivered) return true;
    if (record.cancelConfirmBy !== undefined) return true;
    return record.kind === "agent" && record.child !== undefined;
  });
  return records.length === table.records.length ? table : toTable(records);
}

function issueCommand(table: TaskTable, record: TaskRecord, command: TaskCommand): TaskTransition {
  if (record.child !== undefined) {
    return { effects: [{ commands: [command], kind: "send", record }], table };
  }
  const next = { ...record, pendingCommands: [...(record.pendingCommands ?? []), command] };
  return { effects: [], table: replace(table, next) };
}

/**
 * The background generation an agent starts when it answered before steering
 * messages reached it. It keeps the call and the time limit of the generation
 * it follows, and its result arrives as a `task.result`.
 */
function continueAfterMissedSteers(
  record: TaskRecord,
  settled: TaskRecord,
  missed: number,
  now: string,
): TaskRecord {
  const limitMs =
    record.deadlineAt === undefined
      ? undefined
      : Date.parse(record.deadlineAt) - Date.parse(record.startedAt);
  return withoutUndefined({
    ...settled,
    delivered: false,
    deadlineAt:
      limitMs === undefined ? undefined : new Date(Date.parse(now) + limitMs).toISOString(),
    detachGroup: undefined,
    generation: record.generation + 1,
    inputSeq: undefined,
    mode: "background" as const,
    startedAt: now,
    status: "working" as const,
    steers: missed,
    workflowCaller: undefined,
  });
}

function settleRecord(record: TaskRecord, outcome: TaskOutcome): TaskRecord {
  return withoutUndefined({
    ...record,
    clockStoppedAt: undefined,
    deadlineAt: undefined,
    lastStatus: renderLastStatus(outcome),
    status: outcome.status,
  });
}

function cancelConfirmBy(record: TaskRecord, now: string): string {
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

function replace(table: TaskTable, record: TaskRecord): TaskTable {
  const index = table.records.findIndex((candidate) => candidate.id === record.id);
  if (index < 0) return toTable([...table.records, record]);
  const records = [...table.records];
  records[index] = record;
  return toTable(records);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
