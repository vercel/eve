import type { TaskCancelResult, TaskWaitResult } from "#execution/tasks/calls.js";
import type { WorkflowToolRunCall } from "#execution/tools/workflow/messages.js";
import type { SessionStateMap } from "#harness/types.js";
import { readRunningWork, writeRunningWork } from "#harness/running-work.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { UNREADABLE_TASK_ERROR } from "#execution/tasks/render.js";

export const MAX_WORKING_TASKS = 32;

const MAX_FINISHED_RECORDS = 100;

const MAX_LISTED_IDLE_TASKS = 10;

const TASK_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TASK_ID_SUFFIX_LENGTH = 6;

export interface DirectAgentRun {
  readonly continuationToken: string;
  readonly isModelsTool?: boolean;
  readonly model?: string;
  readonly name: string;
  readonly nodeId: string;
}

export interface TaskRunAddress {
  readonly directAgent?: DirectAgentRun;
  readonly hookToken: string;
  readonly runId: string;
}

export interface TaskRun extends TaskRunAddress {
  readonly started: boolean;
  readonly usage?: TokenUsage;
}

export interface TaskCall {
  readonly callId: string;
  readonly turnId: string;
}

export type TaskRunCommand =
  | { readonly kind: "cancel" }
  | { readonly call: WorkflowToolRunCall; readonly kind: "call" };

export interface TaskRunCommands {
  readonly commands: readonly TaskRunCommand[];
  readonly run: TaskRunAddress;
}

export type TaskOutcome =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" }
  | { readonly reason?: TaskCancelReason; readonly status: "cancelled" };

export type TaskResult = Exclude<TaskOutcome, { readonly status: "cancelled" }> & {
  readonly calls?: readonly TaskCall[];
};

export interface TaskRecord {
  readonly id: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
  readonly resumable: boolean;
  readonly calls: readonly TaskCall[];
  readonly results: readonly TaskResult[];
  readonly cancelled?: boolean;
  readonly run?: TaskRun;
  readonly held?: readonly TaskRunCommand[];
}

export interface TaskTable {
  readonly tasks: readonly TaskRecord[];
}

const EMPTY_TABLE: TaskTable = { tasks: [] };

export function readTaskTable(state: SessionStateMap | undefined): TaskTable {
  const stored = readRunningWork(state).tasks;
  if (stored.length === 0) return EMPTY_TABLE;
  const tasks = stored.flatMap((value) => {
    const record = decodeTaskRecord(value);
    return record === undefined ? [] : [record];
  });
  return { tasks };
}

export function writeTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
): T {
  return {
    ...session,
    state: writeRunningWork(session.state, { tasks: pruneFinishedRecords(table.tasks) }),
  };
}

export function findTask(table: TaskTable, taskId: string): TaskRecord | undefined {
  return table.tasks.find((record) => record.id === taskId);
}

export function isActiveTaskRun(table: TaskTable, taskId: string, runId: string): boolean {
  const record = findTask(table, taskId);
  return record?.cancelled !== true && record?.run?.runId === runId;
}

export function isCancelledTaskRun(table: TaskTable, taskId: string, runId: string): boolean {
  const record = findTask(table, taskId);
  return record?.cancelled === true && record.run?.runId === runId;
}

export function isTaskWorking(record: TaskRecord): boolean {
  return record.calls.length > 0;
}

export function workingTasks(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter(isTaskWorking);
}

export function idleTasks(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter(isResumableTaskIdle).slice(-MAX_LISTED_IDLE_TASKS);
}

export function isTaskAvailable(
  record: TaskRecord | undefined,
  toolName: string,
): record is TaskRecord & { readonly run: TaskRun } {
  return (
    record !== undefined &&
    record.resumable &&
    !record.cancelled &&
    record.run !== undefined &&
    record.name === toolName
  );
}

export function tasksWithResults(table: TaskTable): readonly TaskRecord[] {
  return table.tasks.filter((record) => record.results.length > 0);
}

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

export function taskCancelResult(table: TaskTable, taskId: string): TaskCancelResult | undefined {
  const record = findTask(table, taskId);
  if (record === undefined) return undefined;
  return {
    resumable: record.resumable && record.kind !== "agent",
    status: isTaskWorking(record) ? "cancelled" : "already_finished",
    tool: record.name,
  };
}

export function liveRuns(state: SessionStateMap | undefined): readonly TaskRunAddress[] {
  return [
    ...getBlockingWorkflowToolRuns(state).map((run) => run.address),
    ...liveTaskRuns(readTaskTable(state)),
  ];
}

export function liveTaskRuns(table: TaskTable): readonly TaskRunAddress[] {
  return table.tasks.flatMap((record) =>
    record.run === undefined ? [] : [toRunAddress(record.run)],
  );
}

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

export function removeTask(table: TaskTable, taskId: string): TaskTable {
  return { ...table, tasks: table.tasks.filter((record) => record.id !== taskId) };
}

export function recordTaskRun(table: TaskTable, taskId: string, run: TaskRunAddress): TaskTable {
  return updateTask(table, taskId, (record) => ({
    ...record,
    run: { ...run, started: run.directAgent !== undefined },
  }));
}

export function redirectDirectTaskRun(
  table: TaskTable,
  taskId: string,
  sessionId: string,
  hookToken: string,
): TaskTable {
  return updateTask(table, taskId, (record) =>
    record.run === undefined
      ? record
      : { ...record, run: { ...record.run, hookToken, runId: sessionId } },
  );
}

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
    results:
      outcome.status === "cancelled"
        ? current.results
        : [...current.results, { ...outcome, calls: settled }],
  }));
  return { settled, table: next };
}

export function applyTaskReplyToTable(
  table: TaskTable,
  tasksById: Readonly<Record<string, { readonly status: string }>> | undefined,
  message: {
    readonly callIds: readonly string[];
    readonly from: { readonly runId: string; readonly taskId?: string };
    readonly output: JsonValue;
  },
): {
  readonly record?: TaskRecord;
  readonly settled: readonly TaskCall[];
  readonly table: TaskTable;
} {
  const taskId = message.from.taskId;
  if (taskId === undefined) return { settled: [], table };
  if (tasksById?.[taskId]?.status === "ended") return { settled: [], table };
  if (!isActiveTaskRun(table, taskId, message.from.runId)) return { settled: [], table };
  const record = findTask(table, taskId);
  if (record?.run?.runId !== message.from.runId) return { settled: [], table };
  const outcome: TaskOutcome = { output: message.output, status: "completed" };
  const callIds =
    record.run.directAgent !== undefined
      ? directSettledCallIds(record, message.callIds)
      : message.callIds;
  const settled = settleTaskCalls(table, { callIds, outcome, taskId });
  return { record, settled: settled.settled, table: settled.table };
}

function directSettledCallIds(record: TaskRecord, callIds: readonly string[]): readonly string[] {
  const latest = callIds.at(-1);
  if (latest === undefined) return callIds;
  const index = record.calls.findIndex((call) => call.callId === latest);
  return index < 0 ? callIds : record.calls.slice(0, index + 1).map((call) => call.callId);
}

export function settleRemainingTaskCalls(
  table: TaskTable,
  taskId: string,
  outcome: TaskOutcome,
): { readonly settled: readonly TaskCall[]; readonly table: TaskTable } {
  const callIds = findTask(table, taskId)?.calls.map((call) => call.callId) ?? [];
  return settleTaskCalls(table, { callIds, outcome, taskId });
}

export function recordTaskRunUsage(table: TaskTable, taskId: string, usage: TokenUsage): TaskTable {
  return updateTask(table, taskId, (record) =>
    record.run === undefined ? record : { ...record, run: { ...record.run, usage } },
  );
}

export function finishTaskRun(table: TaskTable, taskId: string, runId: string): TaskTable {
  return updateTask(table, taskId, (record) => {
    if (record.run?.runId !== runId) return record;
    const { held: _held, run: _run, ...rest } = record;
    return rest;
  });
}

export interface TaskCancellation {
  readonly send?: TaskRunCommands;
  readonly settled: readonly TaskCall[];
  readonly table: TaskTable;
}

export function cancelTask(table: TaskTable, taskId: string): TaskCancellation {
  const record = findTask(table, taskId);
  if (record === undefined) return { settled: [], table };
  if (record.resumable && record.kind !== "agent") return cancelResumableTask(table, record);
  const settled = cancelledCalls(record);
  const run = record.run;
  const next = updateTask(table, taskId, (current) => ({
    ...current,
    calls: [],
    cancelled: true,
    held: undefined,
  }));
  return run === undefined || record.cancelled
    ? { settled, table: next }
    : { send: cancelCommand(run), settled, table: next };
}

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

function cancelledCalls(record: TaskRecord): readonly TaskCall[] {
  return record.run === undefined ? [] : record.calls;
}

function toRunAddress(run: TaskRun): TaskRunAddress {
  return {
    ...(run.directAgent !== undefined && { directAgent: run.directAgent }),
    hookToken: run.hookToken,
    runId: run.runId,
  };
}

function createTaskId(table: TaskTable, name: string): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(TASK_ID_SUFFIX_LENGTH));
    const suffix = Array.from(bytes, (byte) => TASK_ID_ALPHABET[byte % 32]).join("");
    const taskId = `${name}-${suffix}`;
    if (findTask(table, taskId) === undefined) return taskId;
  }
}

function isResumableTaskIdle(record: TaskRecord): boolean {
  return (
    record.resumable && !record.cancelled && record.run !== undefined && !isTaskWorking(record)
  );
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
  if (
    value.calls !== undefined &&
    (!Array.isArray(value.calls) || !Array.from(value.calls as unknown[]).every(isTaskCall))
  )
    return false;
  if (value.status === "completed") return "output" in value;
  return value.status === "failed" && typeof value.error === "string";
}

function isDirectAgentRun(value: unknown): value is DirectAgentRun {
  return (
    isObject(value) &&
    isNonEmptyString(value.continuationToken) &&
    (value.isModelsTool === undefined || typeof value.isModelsTool === "boolean") &&
    (value.model === undefined || typeof value.model === "string") &&
    isNonEmptyString(value.name) &&
    typeof value.nodeId === "string"
  );
}

function isTaskRun(value: unknown): value is TaskRun {
  return (
    isObject(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.hookToken) &&
    typeof value.started === "boolean" &&
    (value.directAgent === undefined || isDirectAgentRun(value.directAgent)) &&
    (value.usage === undefined || isObject(value.usage))
  );
}

function isTaskCall(value: unknown): value is TaskCall {
  return isObject(value) && isNonEmptyString(value.callId) && typeof value.turnId === "string";
}

export type TaskCancelReason = "task-cancel" | "turn-cancelled" | "turn-ended";
