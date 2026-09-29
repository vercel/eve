import type { TaskCancelResult, TaskWaitResult } from "#execution/tasks/calls.js";
import type { WorkflowToolRunCall } from "#execution/tools/workflow/messages.js";
import type { SessionStateMap } from "#harness/types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import { UNREADABLE_TASK_ERROR } from "#execution/tasks/render.js";

// The session's task table. Every write to a task record goes through this
// module; callers read with the helpers below and write with `writeTaskTable`.
// Readers run inside the workflow driver, so validation avoids schema runtimes.

const TASK_TABLE_STATE_KEY = "eve.taskTable";
const TASK_TABLE_VERSION = 1;

/** At most this many tasks work at once in one session: a backstop normal use shouldn't reach. */
export const MAX_WORKING_TASKS = 32;

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

/** A call the task admitted and hasn't settled, with the turn that made it. */
export interface TaskCall {
  readonly callId: string;
  readonly turnId: string;
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

/** How a task call ended, as `task.settled` reports it. */
export type TaskOutcome =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" }
  | { readonly status: "cancelled" };

/**
 * An outcome the model receives, one per reply or run end, however many calls
 * it settled. Cancelled work never reports back.
 */
export type TaskResult = Exclude<TaskOutcome, { readonly status: "cancelled" }>;

export interface TaskRecord {
  readonly id: string;
  /** Whether the tool is an agent's, as `task.started` reports it. */
  readonly kind: TaskStartedStreamEvent["data"]["kind"];
  /** The tool whose call started the task. */
  readonly name: string;
  /** A `serve` tool's task: it takes more calls by its id, and is idle between results. */
  readonly resumable: boolean;
  /** Calls without a result. The task is working while any remain. */
  readonly calls: readonly TaskCall[];
  /** Results not yet delivered to the model. */
  readonly results: readonly TaskResult[];
  /** The task's run, from its start until it finishes. */
  readonly run?: TaskRun;
  /** Commands issued before the run could take them, sent in order once it reports started. */
  readonly held?: readonly TaskRunCommand[];
}

export interface TaskTable {
  readonly tasks: readonly TaskRecord[];
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
  return { tasks };
}

export function writeTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
): T {
  const tasks = pruneFinishedRecords(table.tasks);
  if (tasks.length === 0) {
    const state = { ...session.state };
    delete state[TASK_TABLE_STATE_KEY];
    return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
  }
  const stored = { tasks, version: TASK_TABLE_VERSION };
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

export function workingTasks(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter(isTaskWorking);
}

/**
 * The most recently used idle resumable tasks, oldest first. The table keeps
 * records in order of use, so the last ones are the most recent.
 */
export function idleTasks(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter(isResumableTaskIdle).slice(-MAX_LISTED_IDLE_TASKS);
}

/**
 * Whether a call may reach the task by its id: the task is resumable and
 * unfinished, and was started by this tool.
 */
export function isTaskAvailable(
  record: TaskRecord | undefined,
  toolName: string,
): record is TaskRecord & { readonly run: TaskRun } {
  return (
    record !== undefined && record.resumable && record.run !== undefined && record.name === toolName
  );
}

/** Tasks whose results the model has not received yet. */
export function tasksWithResults(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter((record) => record.results.length > 0);
}

/**
 * What a wait on the turn's tasks returns now, or `undefined` to keep
 * waiting. A waiting result, or nothing left working, ends it first;
 * cancelled work never does.
 */
export function taskWaitResult(
  table: TaskTable,
  wake: { readonly interrupted: boolean; readonly timedOut: boolean },
): TaskWaitResult | undefined {
  const settled = tasksWithResults(table).map((record) => ({
    id: record.id,
    status: record.results.at(-1)!.status,
  }));
  const working = workingTasks(table).map((record) => record.id);
  if (settled.length > 0 || working.length === 0) return { settled, status: "settled", working };
  if (wake.interrupted) return { status: "interrupt", working };
  if (wake.timedOut) return { status: "timeout", working };
  return undefined;
}

/**
 * What `task_cancel` answers, or `undefined` for a task that doesn't exist.
 * `cancelled` means the caller cancels the working task.
 */
export function taskCancelResult(table: TaskTable, taskId: string): TaskCancelResult | undefined {
  const record = findTask(table, taskId);
  if (record === undefined) return undefined;
  return {
    resumable: record.resumable,
    status: isTaskWorking(record) ? "cancelled" : "already_finished",
    tool: record.name,
  };
}

/** Runs that may still be doing work, including cancelled runs that haven't confirmed yet. */
export function liveTaskRuns(table: TaskTable): readonly TaskRunAddress[] {
  return table.tasks.flatMap((record) =>
    record.run === undefined ? [] : [toRunAddress(record.run)],
  );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Records a task for a call the model just made, with a new id. */
export function createTask(
  table: TaskTable,
  input: {
    readonly callId: string;
    readonly kind: TaskRecord["kind"];
    readonly name: string;
    readonly resumable: boolean;
    readonly turnId: string;
  },
): { readonly table: TaskTable; readonly taskId: string } {
  const taskId = createTaskId(table, input.name);
  const record: TaskRecord = {
    calls: [{ callId: input.callId, turnId: input.turnId }],
    id: taskId,
    kind: input.kind,
    name: input.name,
    results: [],
    resumable: input.resumable,
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
  const admitted: TaskCall = { callId: call.callId, turnId: call.turnId };
  let updated: TaskRecord = { ...record, calls: [...record.calls, admitted] };
  if (!run.started) updated = { ...updated, held: [...(record.held ?? []), command] };
  const next = { ...table, tasks: [...removeTask(table, taskId).tasks, updated] };
  if (!run.started) return { table: next };
  return { send: { commands: [command], run: toRunAddress(run) }, table: next };
}

/**
 * Settles calls that share one outcome, as one reply does, in one step. Each
 * call settles once, with its own `task.settled`; the first outcome wins, so a
 * call already settled, including one its owner cancelled, is dropped. The
 * model receives the outcome once, since every call it settles would repeat it.
 */
export function settleTaskCalls(
  table: TaskTable,
  input: {
    readonly callIds: readonly string[];
    readonly outcome: TaskOutcome;
    readonly taskId: string;
  },
): { readonly settled: readonly TaskCall[]; readonly table: TaskTable } {
  const settling = new Set(input.callIds);
  const calls = findTask(table, input.taskId)?.calls ?? [];
  const settled = calls.filter((call) => settling.has(call.callId));
  if (settled.length === 0) return { settled, table };
  const { outcome } = input;
  const next = updateTask(table, input.taskId, (current) => ({
    ...current,
    calls: current.calls.filter((call) => !settling.has(call.callId)),
    results: outcome.status === "cancelled" ? current.results : [...current.results, outcome],
  }));
  return { settled, table: next };
}

/**
 * Settles every call still without a result with one outcome, as a run's
 * return or failure does: a task's one call, or every call a resumable task
 * received, or never received, since its last reply.
 */
export function settleRemainingTaskCalls(
  table: TaskTable,
  taskId: string,
  outcome: TaskOutcome,
): { readonly settled: readonly TaskCall[]; readonly table: TaskTable } {
  const callIds = findTask(table, taskId)?.calls.map((call) => call.callId) ?? [];
  return settleTaskCalls(table, { callIds, outcome, taskId });
}

/** The task's run finished; nothing is left to cancel. */
export function finishTaskRun(table: TaskTable, taskId: string, runId: string): TaskTable {
  return updateTask(table, taskId, (record) => {
    if (record.run?.runId !== runId) return record;
    const { held: _held, run: _run, ...rest } = record;
    return rest;
  });
}

/** What cancelling a task changed, and the command to send its run, if any. */
export interface TaskCancellation {
  readonly send?: TaskRunCommands;
  readonly settled: readonly TaskCall[];
  readonly table: TaskTable;
}

/**
 * Cancels a task's current work: its calls settle as cancelled and never
 * report back, and a live run is told to stop. A run that hasn't started
 * holds the cancel. A resumable task stays available and becomes idle.
 */
export function cancelTask(table: TaskTable, taskId: string): TaskCancellation {
  const record = findTask(table, taskId);
  if (record === undefined) return { settled: [], table };
  if (record.resumable) return cancelResumableTask(table, record);
  const settled = cancelledCalls(record);
  const run = record.run;
  const next = updateTask(table, taskId, (current) => {
    const cancelled: TaskRecord = { ...current, calls: [] };
    if (run === undefined || run.started) return cancelled;
    return { ...cancelled, held: [{ kind: "cancel" }] };
  });
  if (run === undefined || !run.started) return { settled, table: next };
  return { send: cancelCommand(run), settled, table: next };
}

/**
 * A resumable run aborts only its current stretch of work and stays parked for
 * later calls. Calls held for a run that hasn't started settle here, so only
 * the cancel is still held for it.
 */
function cancelResumableTask(table: TaskTable, record: TaskRecord): TaskCancellation {
  const run = record.run;
  if (run === undefined || !isTaskWorking(record)) return { settled: [], table };
  const settled = cancelledCalls(record);
  const next = updateTask(table, record.id, (current) => {
    const idle: TaskRecord = { ...current, calls: [] };
    return run.started ? idle : { ...idle, held: [{ kind: "cancel" }] };
  });
  if (!run.started) return { settled, table: next };
  return { send: cancelCommand(run), settled, table: next };
}

function cancelCommand(run: TaskRun): TaskRunCommands {
  return { commands: [{ kind: "cancel" }], run: toRunAddress(run) };
}

/**
 * Hands every undelivered result to the model, which receives each
 * once: `taken` is each record with its results, before they were cleared.
 */
export function takeTaskResults(table: TaskTable): {
  readonly taken: readonly TaskRecord[];
  readonly table: TaskTable;
} {
  const taken = tasksWithResults(table);
  const tasks = table.tasks.map((record) =>
    taken.includes(record) ? { ...record, results: [] } : record,
  );
  return { table: { ...table, tasks }, taken };
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
function cancelledCalls(record: TaskRecord): readonly TaskCall[] {
  return record.run === undefined ? [] : record.calls;
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
    id: value.id,
    kind: value.kind === "agent" ? "agent" : "tool",
    name: value.name,
    results: [{ error: UNREADABLE_TASK_ERROR, status: "failed" }],
    resumable: false,
  };
}

function isTaskRecord(value: unknown): value is TaskRecord {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    (value.kind === "agent" || value.kind === "tool") &&
    typeof value.resumable === "boolean" &&
    Array.isArray(value.calls) &&
    Array.from(value.calls as unknown[]).every(isTaskCall) &&
    Array.isArray(value.results) &&
    Array.from(value.results as unknown[]).every(isTaskResult) &&
    (value.run === undefined || isTaskRun(value.run)) &&
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
  if (!isObject(value)) return false;
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

function isTaskCall(value: unknown): value is TaskCall {
  return isObject(value) && isNonEmptyString(value.callId) && typeof value.turnId === "string";
}
