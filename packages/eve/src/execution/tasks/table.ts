import type { WorkflowToolRunCall } from "#execution/tools/workflow/messages.js";
import type { SessionStateMap } from "#harness/types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";
import { UNREADABLE_TASK_ERROR } from "#execution/tasks/render.js";

// The session's task table. Every write to a task record goes through this
// module; callers read with the helpers below and write with `writeTaskTable`.
// Readers run inside the workflow driver, so validation avoids schema runtimes.

const TASK_TABLE_STATE_KEY = "eve.taskTable";
const TASK_TABLE_VERSION = 1;

/** At most this many tasks work at once in one session: a backstop normal use shouldn't reach. */
export const MAX_WORKING_TASKS = 32;

/** How long a cancelled run has to confirm before the session hard-stops it. */
export const TASK_HARD_STOP_MS = 30_000;

/** Finished records kept so `task_cancel` can still answer `already_finished`. */
const MAX_FINISHED_RECORDS = 100;

/** Idle resumable tasks the `[Tasks]` note lists: the most recently used ones. */
const MAX_LISTED_IDLE_TASKS = 10;

const TASK_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TASK_ID_SUFFIX_LENGTH = 6;

export interface TaskRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}

/** The workflow run doing a task's work. `started` once its control hook can take commands. */
export interface TaskRun extends TaskRunAddress {
  readonly started: boolean;
}

/**
 * A command for a task's run. Commands go over the run's one control hook, so
 * the run sees calls and cancels in the order the session issued them.
 */
export type TaskRunCommand =
  | { readonly kind: "cancel" }
  | { readonly call: WorkflowToolRunCall; readonly kind: "call" };

/** Commands for one run, to send in order. */
export interface TaskRunCommands {
  readonly commands: readonly TaskRunCommand[];
  readonly run: TaskRunAddress;
}

/** One settled call's result, kept until the model receives it. */
export type TaskResult =
  | { readonly callId: string; readonly output: JsonValue; readonly status: "completed" }
  | { readonly callId: string; readonly error: string; readonly status: "failed" };

export interface TaskRecord {
  readonly id: string;
  /** The tool whose call started the task. */
  readonly name: string;
  /** A `serve` tool's task: it takes more calls by its id, and is idle between results. */
  readonly resumable: boolean;
  /** Principal of the caller that started the task; only it may wait on or cancel it. */
  readonly creator: string;
  /** The turn whose model step started the task. */
  readonly turnId: string;
  /** Calls without a result. The task is working while any remain. */
  readonly calls: readonly string[];
  /** Results not yet delivered to the model. */
  readonly results: readonly TaskResult[];
  /** The task's run, from its start until it finishes or is hard-stopped. */
  readonly run?: TaskRun;
  /** When the owner cancelled the run; the run is hard-stopped if it hasn't finished in time. */
  readonly cancelledAt?: number;
  /** Commands issued before the run could take them, sent in order once it reports started. */
  readonly held?: readonly TaskRunCommand[];
}

export interface TaskTable {
  /** When the hard-stop sleeper is armed to wake the session. */
  readonly hardStopAt?: number;
  readonly tasks: readonly TaskRecord[];
}

/** How a call settled, as `task.settled` reports it. */
export type TaskCallOutcome =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" }
  | { readonly status: "cancelled" };

export type TaskSettlement = TaskCallOutcome & {
  readonly callId: string;
  readonly taskId: string;
};

/** A result handed to the model, with the task it belongs to. */
export interface DeliveredTaskResult {
  readonly name: string;
  readonly result: TaskResult;
  readonly taskId: string;
}

const EMPTY_TABLE: TaskTable = { tasks: [] };

export function readTaskTable(state: SessionStateMap | undefined): TaskTable {
  const stored = state?.[TASK_TABLE_STATE_KEY];
  if (!isObject(stored) || stored.version !== TASK_TABLE_VERSION || !Array.isArray(stored.tasks)) {
    return EMPTY_TABLE;
  }
  const tasks = Array.from(stored.tasks as unknown[]).flatMap((value) => {
    const record = decodeTaskRecord(value);
    return record === undefined ? [] : [record];
  });
  return typeof stored.hardStopAt === "number"
    ? { hardStopAt: stored.hardStopAt, tasks }
    : { tasks };
}

export function writeTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
): T {
  const tasks = pruneFinishedRecords(table.tasks);
  if (tasks.length === 0 && table.hardStopAt === undefined) {
    const state = { ...session.state };
    delete state[TASK_TABLE_STATE_KEY];
    return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
  }
  const stored: Record<string, unknown> = { tasks, version: TASK_TABLE_VERSION };
  if (table.hardStopAt !== undefined) stored.hardStopAt = table.hardStopAt;
  return { ...session, state: { ...session.state, [TASK_TABLE_STATE_KEY]: stored } };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function findTask(table: TaskTable, taskId: string): TaskRecord | undefined {
  return table.tasks.find((record) => record.id === taskId);
}

export function isTaskWorking(record: TaskRecord): boolean {
  return record.calls.length > 0;
}

/** The tool a task id names: ids are `<tool>-<6 base32>`. */
export function taskToolName(taskId: string): string {
  const separator = taskId.lastIndexOf("-");
  return separator > 0 ? taskId.slice(0, separator) : taskId;
}

/** Working tasks, optionally only those one principal started. */
export function workingTasks(table: TaskTable, principal?: string): readonly TaskRecord[] {
  return table.tasks.filter(
    (record) => isTaskWorking(record) && (principal === undefined || record.creator === principal),
  );
}

/**
 * The principal's most recently used idle resumable tasks, oldest first. The
 * table keeps records in order of use, so the last ones are the most recent.
 */
export function idleTasks(table: TaskTable, principal: string): readonly TaskRecord[] {
  const idle = table.tasks.filter(
    (record) => record.creator === principal && isResumableTaskIdle(record),
  );
  return idle.slice(-MAX_LISTED_IDLE_TASKS);
}

/**
 * Whether a call may reach the task by its id: the task is resumable and
 * unfinished, and was started by this tool for this principal.
 */
export function isTaskAvailable(
  record: TaskRecord | undefined,
  caller: { readonly principal: string; readonly toolName: string },
): record is TaskRecord & { readonly run: TaskRun } {
  return (
    record !== undefined &&
    record.resumable &&
    record.run !== undefined &&
    record.name === caller.toolName &&
    record.creator === caller.principal
  );
}

/** Tasks whose results the principal's model has not received yet. */
export function tasksWithResults(table: TaskTable, principal: string): readonly TaskRecord[] {
  return table.tasks.filter((record) => record.creator === principal && record.results.length > 0);
}

/** Runs that may still be doing work, including cancelled runs that haven't confirmed yet. */
export function liveTaskRuns(table: TaskTable): readonly TaskRunAddress[] {
  return table.tasks.flatMap((record) =>
    record.run === undefined ? [] : [toRunAddress(record.run)],
  );
}

/** When the earliest cancelled run is due for a hard stop. */
export function nextHardStopDue(table: TaskTable): number | undefined {
  let due: number | undefined;
  for (const record of table.tasks) {
    if (record.cancelledAt === undefined || record.run === undefined) continue;
    const at = record.cancelledAt + TASK_HARD_STOP_MS;
    if (due === undefined || at < due) due = at;
  }
  return due;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Records a task for a call the model just made, with a new id. */
export function createTask(
  table: TaskTable,
  input: {
    readonly callId: string;
    readonly creator: string;
    readonly name: string;
    readonly resumable: boolean;
    readonly turnId: string;
  },
): { readonly table: TaskTable; readonly taskId: string } {
  const taskId = createTaskId(table, input.name);
  const record: TaskRecord = {
    calls: [input.callId],
    creator: input.creator,
    id: taskId,
    name: input.name,
    results: [],
    resumable: input.resumable,
    turnId: input.turnId,
  };
  return { table: { ...table, tasks: [...table.tasks, record] }, taskId };
}

/** Drops a task that never started, such as one past the cap. */
export function removeTask(table: TaskTable, taskId: string): TaskTable {
  return { ...table, tasks: table.tasks.filter((record) => record.id !== taskId) };
}

export function recordTaskRun(table: TaskTable, taskId: string, run: TaskRunAddress): TaskTable {
  return updateTask(table, taskId, (record) => ({ ...record, run: { ...run, started: false } }));
}

/**
 * The run can take commands now. Commands issued before this were held on the
 * record; they are returned, in order, so the caller sends them.
 */
export function markTaskRunStarted(
  table: TaskTable,
  taskId: string,
  runId: string,
): { readonly held?: TaskRunCommands; readonly table: TaskTable } {
  const record = findTask(table, taskId);
  if (record?.run === undefined || record.run.runId !== runId || record.run.started) {
    return { table };
  }
  const run = { ...record.run, started: true };
  const next = updateTask(table, taskId, (current) => {
    const { held: _held, ...rest } = current;
    return { ...rest, run };
  });
  if (record.held === undefined) return { table: next };
  return { held: { commands: record.held, run: toRunAddress(run) }, table: next };
}

/**
 * Records a call that reaches an available task by its id: the task is
 * working until the call has a result. The call goes to a started run now, or
 * is held until the run reports started. The record moves to the end of the
 * table, which keeps records in order of use.
 */
export function recordTaskCall(
  table: TaskTable,
  taskId: string,
  call: WorkflowToolRunCall,
): { readonly send?: TaskRunCommands; readonly table: TaskTable } {
  const record = findTask(table, taskId);
  if (record?.run === undefined) return { table };
  const command: TaskRunCommand = { call, kind: "call" };
  const run = record.run;
  let updated: TaskRecord = { ...record, calls: [...record.calls, call.callId] };
  if (!run.started) updated = { ...updated, held: [...(record.held ?? []), command] };
  const next = { ...table, tasks: [...removeTask(table, taskId).tasks, updated] };
  if (!run.started) return { table: next };
  return { send: { commands: [command], run: toRunAddress(run) }, table: next };
}

/**
 * Settles one call. The first outcome wins: a call already settled, including
 * one its owner cancelled, is dropped.
 */
export function settleTaskCall(
  table: TaskTable,
  input: { readonly callId: string; readonly outcome: TaskCallOutcome; readonly taskId: string },
): { readonly settlement?: TaskSettlement; readonly table: TaskTable } {
  const record = findTask(table, input.taskId);
  if (record === undefined || !record.calls.includes(input.callId)) return { table };
  const settlement: TaskSettlement = {
    ...input.outcome,
    callId: input.callId,
    taskId: input.taskId,
  };
  const result = toTaskResult(input.callId, input.outcome);
  const next = updateTask(table, input.taskId, (current) => ({
    ...current,
    calls: current.calls.filter((callId) => callId !== input.callId),
    results: result === undefined ? current.results : [...current.results, result],
  }));
  return { settlement, table: next };
}

/**
 * Settles every call still without a result with one outcome, as a run's
 * return or failure does: a task's one call, or every call a resumable task
 * received, or never received, since its last reply.
 */
export function settleRemainingTaskCalls(
  table: TaskTable,
  taskId: string,
  outcome: TaskCallOutcome,
): { readonly settlements: readonly TaskSettlement[]; readonly table: TaskTable } {
  const settlements: TaskSettlement[] = [];
  let next = table;
  for (const callId of findTask(table, taskId)?.calls ?? []) {
    const settled = settleTaskCall(next, { callId, outcome, taskId });
    next = settled.table;
    if (settled.settlement !== undefined) settlements.push(settled.settlement);
  }
  return { settlements, table: next };
}

/** The task's run finished; nothing is left to cancel or hard-stop. */
export function finishTaskRun(table: TaskTable, taskId: string, runId: string): TaskTable {
  return updateTask(table, taskId, (record) => {
    if (record.run?.runId !== runId) return record;
    const { cancelledAt: _cancelledAt, held: _held, run: _run, ...rest } = record;
    return rest;
  });
}

/** What cancelling a task changed, and the command to send its run, if any. */
export interface TaskCancellation {
  readonly send?: TaskRunCommands;
  readonly settlements: readonly TaskSettlement[];
  readonly table: TaskTable;
}

/**
 * Cancels a task's current work: its calls settle as cancelled and never
 * report back, and a live run is told to stop. A run that hasn't started
 * holds the cancel. A resumable task stays available and becomes idle.
 */
export function cancelTask(table: TaskTable, taskId: string, now: number): TaskCancellation {
  const record = findTask(table, taskId);
  if (record === undefined) return { settlements: [], table };
  if (record.resumable) return cancelResumableTask(table, record);
  const settlements = cancelledSettlements(record);
  const alreadyCancelled = record.cancelledAt !== undefined;
  const run = record.run;
  const next = updateTask(table, taskId, (current) => {
    const cancelled: TaskRecord = { ...current, calls: [] };
    if (run === undefined || alreadyCancelled) return cancelled;
    if (!run.started) return { ...cancelled, cancelledAt: now, held: [{ kind: "cancel" }] };
    return { ...cancelled, cancelledAt: now };
  });
  if (run === undefined || !run.started || alreadyCancelled) return { settlements, table: next };
  return { send: cancelCommand(run), settlements, table: next };
}

/**
 * A resumable run aborts only its current stretch of work and stays parked for
 * later calls, so it needs no hard stop. Calls held for a run that hasn't
 * started settle here, so only the cancel is still held for it.
 */
function cancelResumableTask(table: TaskTable, record: TaskRecord): TaskCancellation {
  const run = record.run;
  if (run === undefined || !isTaskWorking(record)) return { settlements: [], table };
  const settlements = cancelledSettlements(record);
  const next = updateTask(table, record.id, (current) => {
    const idle: TaskRecord = { ...current, calls: [] };
    return run.started ? idle : { ...idle, held: [{ kind: "cancel" }] };
  });
  if (!run.started) return { settlements, table: next };
  return { send: cancelCommand(run), settlements, table: next };
}

function cancelCommand(run: TaskRun): TaskRunCommands {
  return { commands: [{ kind: "cancel" }], run: toRunAddress(run) };
}

/** Hands the principal's undelivered results to the model, which receives each once. */
export function takeTaskResults(
  table: TaskTable,
  principal: string,
): { readonly delivered: readonly DeliveredTaskResult[]; readonly table: TaskTable } {
  const delivered: DeliveredTaskResult[] = [];
  const tasks = table.tasks.map((record) => {
    if (record.creator !== principal || record.results.length === 0) return record;
    for (const result of record.results) {
      delivered.push({ name: record.name, result, taskId: record.id });
    }
    return { ...record, results: [] };
  });
  return { delivered, table: { ...table, tasks } };
}

/** Takes the cancelled runs whose confirmation is overdue, so the caller stops them. */
export function takeOverdueRuns(
  table: TaskTable,
  now: number,
): { readonly runs: readonly TaskRunAddress[]; readonly table: TaskTable } {
  const runs: TaskRunAddress[] = [];
  const tasks = table.tasks.map((record) => {
    if (record.cancelledAt === undefined || record.run === undefined) return record;
    if (record.cancelledAt + TASK_HARD_STOP_MS > now) return record;
    runs.push(toRunAddress(record.run));
    const { cancelledAt: _cancelledAt, held: _held, run: _run, ...rest } = record;
    return rest;
  });
  return { runs, table: { ...table, tasks } };
}

export function setHardStopAt(table: TaskTable, at: number | undefined): TaskTable {
  if (at === undefined) {
    const { hardStopAt: _hardStopAt, ...rest } = table;
    return rest;
  }
  return { ...table, hardStopAt: at };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateTask(
  table: TaskTable,
  taskId: string,
  update: (record: TaskRecord) => TaskRecord,
): TaskTable {
  return {
    ...table,
    tasks: table.tasks.map((record) => (record.id === taskId ? update(record) : record)),
  };
}

/** A task the session never started reported no `task.started`, so it settles nothing. */
function cancelledSettlements(record: TaskRecord): TaskSettlement[] {
  if (record.run === undefined) return [];
  return record.calls.map((callId) => ({ callId, status: "cancelled", taskId: record.id }));
}

function toTaskResult(callId: string, outcome: TaskCallOutcome): TaskResult | undefined {
  switch (outcome.status) {
    case "completed":
      return { callId, output: outcome.output, status: "completed" };
    case "failed":
      return { callId, error: outcome.error, status: "failed" };
    case "cancelled":
      return undefined;
  }
}

function toRunAddress(run: TaskRun): TaskRunAddress {
  return { hookToken: run.hookToken, runId: run.runId };
}

/** `<tool>-<6 base32>`, unique within the table. */
function createTaskId(table: TaskTable, name: string): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(TASK_ID_SUFFIX_LENGTH));
    const suffix = Array.from(bytes, (byte) => TASK_ID_ALPHABET[byte % 32]).join("");
    const taskId = `${name}-${suffix}`;
    if (findTask(table, taskId) === undefined) return taskId;
  }
}

function isResumableTaskIdle(record: TaskRecord): boolean {
  return record.resumable && record.run !== undefined && !isTaskWorking(record);
}

function isFinishedRecord(record: TaskRecord): boolean {
  return record.calls.length === 0 && record.results.length === 0 && record.run === undefined;
}

function pruneFinishedRecords(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
  const finished = tasks.filter(isFinishedRecord);
  const excess = finished.length - MAX_FINISHED_RECORDS;
  if (excess <= 0) return tasks;
  const dropped = new Set(finished.slice(0, excess));
  return tasks.filter((record) => !dropped.has(record));
}

function decodeTaskRecord(value: unknown): TaskRecord | undefined {
  if (isTaskRecord(value)) return value;
  // A record that can't be read fails its task, never the session.
  if (!isObject(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.name)) {
    return undefined;
  }
  return {
    calls: [],
    creator: typeof value.creator === "string" ? value.creator : "",
    id: value.id,
    name: value.name,
    results: [{ callId: "", error: UNREADABLE_TASK_ERROR, status: "failed" }],
    resumable: false,
    turnId: typeof value.turnId === "string" ? value.turnId : "",
  };
}

function isTaskRecord(value: unknown): value is TaskRecord {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    typeof value.resumable === "boolean" &&
    typeof value.creator === "string" &&
    typeof value.turnId === "string" &&
    isStringArray(value.calls) &&
    Array.isArray(value.results) &&
    Array.from(value.results as unknown[]).every(isTaskResult) &&
    (value.run === undefined || isTaskRun(value.run)) &&
    (value.cancelledAt === undefined || typeof value.cancelledAt === "number") &&
    (value.held === undefined ||
      (Array.isArray(value.held) && Array.from(value.held as unknown[]).every(isTaskRunCommand)))
  );
}

function isTaskRunCommand(value: unknown): value is TaskRunCommand {
  if (!isObject(value)) return false;
  if (value.kind === "cancel") return true;
  return value.kind === "call" && isObject(value.call) && isNonEmptyString(value.call.callId);
}

function isTaskResult(value: unknown): value is TaskResult {
  if (!isObject(value) || typeof value.callId !== "string") return false;
  if (value.status === "completed") return "output" in value;
  return value.status === "failed" && typeof value.error === "string";
}

function isTaskRun(value: unknown): value is TaskRun {
  return (
    isObject(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.hookToken) &&
    typeof value.started === "boolean"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && Array.from(value as unknown[]).every((item) => typeof item === "string")
  );
}
