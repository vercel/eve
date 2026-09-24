import type { SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { deriveTaskId } from "#tasks/ids.js";
import {
  isTerminalTaskStatus,
  type TaskCommand,
  type TaskError,
  type TaskKind,
  type TaskMessage,
  type TaskMode,
  type TaskOutcome,
} from "#tasks/protocol.js";
import { decodeTaskRecord, TASK_RECORD_VERSION, type TaskRecord } from "#tasks/record.js";

/** Session state key holding the owner's task records. */
export const TASK_TABLE_STATE_KEY = "eve.taskTable";

/** How long a cancelled child has to confirm before the owner hard-stops it. */
export const TASK_CANCEL_CONFIRM_MS = 30_000;

/** Default time limit for one agent generation, in active (non-waiting) time. */
export const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60_000;

const LAST_STATUS_MAX_LENGTH = 200;

export interface TaskTable {
  readonly records: readonly TaskRecord[];
}

/** A record that could not be decoded; it is reported as `STATE_LOST` and removed. */
export interface LostTask {
  readonly id?: string;
  readonly name?: string;
  readonly reason: string;
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
       * A child the owner cancelled confirmed it stopped. Nothing reaches the
       * model, but its usage still counts.
       */
      readonly kind: "confirmed";
      readonly record: TaskRecord;
      readonly usage?: TokenUsage;
    }
  | { readonly kind: "reconcile"; readonly record: TaskRecord }
  | { readonly kind: "hard-stop"; readonly record: TaskRecord };

export interface TaskTransition {
  readonly table: TaskTable;
  readonly effects: readonly TaskEffect[];
}

const EMPTY_TABLE: TaskTable = { records: [] };

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
      lost.push(loss);
      continue;
    }
    if (ids.has(decoded.record.id)) {
      lost.push({ id: decoded.record.id, name: decoded.record.name, reason: "duplicate id" });
      continue;
    }
    ids.add(decoded.record.id);
    records.push(decoded.record);
  }
  return { lost, table: { records } };
}

export function writeTaskTable(
  state: SessionStateMap | undefined,
  table: TaskTable,
): SessionStateMap | undefined {
  if (table.records.length === 0) {
    if (state?.[TASK_TABLE_STATE_KEY] === undefined) return state;
    const next = { ...state };
    delete next[TASK_TABLE_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return { ...state, [TASK_TABLE_STATE_KEY]: { records: table.records } };
}

export function findTask(table: TaskTable, taskId: string): TaskRecord | undefined {
  return table.records.find((record) => record.id === taskId);
}

export type StartTaskResult =
  | { readonly kind: "started"; readonly table: TaskTable; readonly record: TaskRecord }
  /** A replayed call whose record already exists; its side effects already ran. */
  | { readonly kind: "existing"; readonly record: TaskRecord }
  | {
      /** The call named a working agent; the message joins its current generation. */
      readonly kind: "steered";
      readonly transition: TaskTransition;
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
  /** Message and schema forwarded when `agentId` names a working agent. */
  readonly steering?: { readonly message: string; readonly outputSchema?: JsonObject };
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

  const deadlineAt =
    input.timeoutMs === false || input.timeoutMs === undefined
      ? undefined
      : new Date(Date.parse(input.now) + input.timeoutMs).toISOString();

  if (input.agentId !== undefined) {
    const agent = findTask(table, input.agentId);
    if (agent === undefined) {
      return {
        kind: "rejected",
        error: {
          code: "UNKNOWN_AGENT",
          message: `No agent with id "${input.agentId}" exists in this session. Omit agentId to start a new agent.`,
        },
      };
    }
    if (agent.kind !== "agent") {
      return {
        kind: "rejected",
        error: {
          code: "UNKNOWN_AGENT",
          message: `"${input.agentId}" is a task, not an agent. Use task_cancel to stop it.`,
        },
      };
    }
    if (
      agent.name !== input.name ||
      (input.nodeId !== undefined && agent.nodeId !== input.nodeId)
    ) {
      return {
        kind: "rejected",
        error: {
          code: "AGENT_MISMATCH",
          message: `Agent "${agent.id}" is a ${agent.name} agent. Call the ${agent.name} tool to continue it.`,
        },
      };
    }
    if (isTerminalTaskStatus(agent.status) && agent.child === undefined) {
      return {
        kind: "rejected",
        error: {
          code: "AGENT_UNREACHABLE",
          message: `Agent "${agent.id}" can no longer be given more work. Omit agentId to start a new agent.`,
        },
      };
    }
    if (!isTerminalTaskStatus(agent.status)) {
      const command: TaskCommand = withoutUndefined({
        kind: "message" as const,
        message: input.steering?.message ?? "",
        outputSchema: input.steering?.outputSchema,
      });
      const transition = issueCommand(table, agent, command);
      return { kind: "steered", record: findTask(transition.table, agent.id)!, transition };
    }
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
  return { kind: "started", record, table: { records: [...table.records, record] } };
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
      return {
        effects: [
          withoutUndefined({
            kind: "settled" as const,
            outcome: message.outcome,
            record: next,
            usage: message.usage,
          }),
        ],
        table: replace(table, next),
      };
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
    cancelConfirmBy: new Date(Date.parse(now) + TASK_CANCEL_CONFIRM_MS).toISOString(),
    clockStoppedAt: undefined,
    deadlineAt: undefined,
    // The owner already knows the outcome; there is nothing left to deliver.
    delivered: true,
    lastStatus: summarizeOutcome({ status: "cancelled" }),
    status: "cancelled" as const,
  });
  return issueCommand(replace(table, cancelled), cancelled, { kind: "cancel" });
}

/** Settles a task that did not finish in time and asks its child to stop. */
export function timeOutTask(table: TaskTable, taskId: string, now: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined || isTerminalTaskStatus(record.status)) return { effects: [], table };
  const outcome: TaskOutcome = {
    error: {
      code: "TIMED_OUT",
      message: `The task did not finish within its time limit and was stopped.`,
    },
    status: "failed",
  };
  const timedOut = withoutUndefined({
    ...settleRecord(record, outcome),
    cancelConfirmBy: new Date(Date.parse(now) + TASK_CANCEL_CONFIRM_MS).toISOString(),
  });
  const commanded = issueCommand(replace(table, timedOut), timedOut, { kind: "cancel" });
  return {
    effects: [{ kind: "settled", outcome, record: timedOut }, ...commanded.effects],
    table: commanded.table,
  };
}

/**
 * Evaluates deadlines. Due working tasks need one reconciliation read; a
 * cancelled task past its confirmation window needs a hard stop.
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
      effects.push({ kind: "reconcile", record });
      continue;
    }
    if (record.cancelConfirmBy !== undefined && Date.parse(record.cancelConfirmBy) <= nowMs) {
      const confirmed = withoutUndefined({ ...record, cancelConfirmBy: undefined });
      next = replace(next, confirmed);
      if (record.child !== undefined && record.child.kind !== "remote") {
        effects.push({ kind: "hard-stop", record: confirmed });
      }
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

/** Moves waited tasks to the background as one detach group. */
export function detachTasks(
  table: TaskTable,
  taskIds: readonly string[],
  detachGroup: string,
): TaskTable {
  let next = table;
  for (const taskId of taskIds) {
    const record = findTask(next, taskId);
    if (record === undefined || record.mode === "background") continue;
    next = replace(next, { ...record, detachGroup, mode: "background" });
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
  return records.length === table.records.length ? table : { records };
}

/** Removes one agent record, for example after its child session ended. */
export function removeTask(table: TaskTable, taskId: string): TaskTable {
  const records = table.records.filter((record) => record.id !== taskId);
  return records.length === table.records.length ? table : { records };
}

/** Agents that finished their last generation and can be given more work. */
export function idleAgents(table: TaskTable): readonly TaskRecord[] {
  return table.records.filter(
    (record) =>
      record.kind === "agent" && record.child !== undefined && isTerminalTaskStatus(record.status),
  );
}

function issueCommand(table: TaskTable, record: TaskRecord, command: TaskCommand): TaskTransition {
  if (record.child !== undefined) {
    return { effects: [{ commands: [command], kind: "send", record }], table };
  }
  const next = { ...record, pendingCommands: [...(record.pendingCommands ?? []), command] };
  return { effects: [], table: replace(table, next) };
}

function settleRecord(record: TaskRecord, outcome: TaskOutcome): TaskRecord {
  return withoutUndefined({
    ...record,
    clockStoppedAt: undefined,
    deadlineAt: undefined,
    lastStatus: summarizeOutcome(outcome),
    status: outcome.status,
  });
}

function summarizeOutcome(outcome: TaskOutcome): string {
  const text =
    outcome.status === "completed"
      ? typeof outcome.output === "string"
        ? outcome.output
        : JSON.stringify(outcome.output)
      : outcome.status === "failed"
        ? `Failed: ${outcome.error.message}`
        : "Cancelled.";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= LAST_STATUS_MAX_LENGTH
    ? line
    : `${line.slice(0, LAST_STATUS_MAX_LENGTH - 1)}…`;
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
  if (index < 0) return { records: [...table.records, record] };
  const records = [...table.records];
  records[index] = record;
  return { records };
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
