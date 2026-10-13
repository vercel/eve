import {
  renderTaskReceipt,
  renderTaskSentReceipt,
  renderTooManyTasksError,
  renderUnknownTaskError,
} from "#execution/tasks/render.js";
import { sendTaskRunCommands } from "#execution/tasks/steps.js";
import {
  findTask,
  isTaskAvailable,
  isTaskWorking,
  MAX_WORKING_TASKS,
  readTaskTable,
  recordTaskCall,
  recordTaskRun,
  removeTask,
  workingTasks,
  writeTaskTable,
  type TaskRecord,
  type TaskTable,
} from "#execution/tasks/table.js";
import {
  startFailureResult,
  startWorkflowToolCallRun,
  type StartWorkflowTaskInput,
} from "#execution/tools/workflow/start.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import { TOO_MANY_TASKS_CODE, UNKNOWN_TASK_CODE } from "#protocol/task-tools.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolRunEntry,
} from "#shared/action-types.js";

const log = createLogger("execution.tasks");

type TaskDispatchInput = StartWorkflowTaskInput & { readonly taskId: string };

/** The call's answer, and the task start the dispatch step reports for it. */
interface TaskDispatchResult {
  readonly result: RuntimeToolResultActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskStartedStreamEvent["data"];
}

/** The entry of a run that does a task's work. */
type TaskRunEntry = Extract<WorkflowToolRunEntry, { readonly taskId: string }>;

/**
 * Starts the run for a task its model step committed, once, and answers the
 * call with its receipt and the `task.started` event the dispatch step
 * publishes. Runs inside that step, where the task's cap is enforced: past
 * it, the record is dropped and the call fails.
 */
export async function startTaskRun(
  input: StartWorkflowTaskInput & { readonly entry: TaskRunEntry },
): Promise<TaskDispatchResult> {
  const { entry, session, task } = input;
  const { taskId } = entry;
  const dispatch = { ...input, taskId };
  const receipt = startReceipt(dispatch, entry.entryPoint === "serve");
  const table = readTaskTable(session.state);
  const record = startableTask(table, taskId);
  if (record === undefined) return { result: receipt, session };

  const overCap = tooManyTasks(dispatch, table);
  if (overCap !== undefined) {
    return { result: overCap, session: writeTaskTable(session, removeTask(table, taskId)) };
  }

  let address;
  try {
    address = await startWorkflowToolCallRun(input, entry);
  } catch (error) {
    logError(log, "task run failed to start", error, { taskId, toolName: task.toolName });
    return {
      result: startFailureResult(task, error),
      session: writeTaskTable(session, removeTask(table, taskId)),
    };
  }

  return {
    result: receipt,
    session: writeTaskTable(session, recordTaskRun(table, taskId, address)),
    started: taskStartedEvent(dispatch, record),
  };
}

/**
 * Sends a call to the `serve` task it names by `taskId`. The task must be
 * available to the tool, and a call that makes an idle task work again
 * counts toward the cap. The call is recorded, reported as started, and sent
 * to the task's run, whose body receives it from `receive()`.
 */
export async function sendToTask(input: TaskDispatchInput): Promise<TaskDispatchResult> {
  const { session, task, taskId } = input;
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  if (!isTaskAvailable(record, task.toolName)) {
    return { result: unknownTaskResult(input), session };
  }

  if (!isTaskWorking(record)) {
    const overCap = tooManyTasks(input, table);
    if (overCap !== undefined) return { result: overCap, session };
  }

  const recorded = recordTaskCall(table, taskId, {
    agentContext: input.agentContext,
    auth: input.auth,
    callId: task.callId,
    executeInput: task.executeInput,
    input: task.input,
    sequence: input.batchEvent.sequence,
    stepIndex: input.batchEvent.stepIndex,
    turnId: input.batchEvent.turnId,
  });
  if (recorded.send !== undefined) await sendTaskRunCommands(recorded.send);
  return {
    result: toolResult(input, renderTaskSentReceipt(taskId)),
    session: writeTaskTable(session, recorded.table),
    started: taskStartedEvent(input, record),
  };
}

/**
 * The entry of the run that dispatching `task` starts, or `undefined` when it
 * starts none: a call to a running task, or a task cancelled before the
 * session could start it. The task cap can still refuse a task's run.
 */
export function runEntryToStart(
  table: TaskTable,
  task: RuntimeWorkflowTaskRequest,
): WorkflowToolRunEntry | undefined {
  const { entry } = task;
  switch (entry.entryPoint) {
    case "execute":
      return { entryPoint: "execute" };
    case "task":
    case "serve":
      return startableTask(table, entry.taskId) === undefined ? undefined : entry;
    case "receive":
      return undefined;
  }
}

/** The task's record while it still needs its run, which it doesn't once cancelled. */
function startableTask(table: TaskTable, taskId: string): TaskRecord | undefined {
  const record = findTask(table, taskId);
  return record !== undefined && isTaskWorking(record) ? record : undefined;
}

/**
 * Whether dispatching `tasks` in order starts every run {@link runEntryToStart}
 * names. A call to a running task can take a slot under the task cap, and
 * sending to it can fail the batch, so such a batch never qualifies.
 */
export function startsEveryRun(
  table: TaskTable,
  tasks: readonly RuntimeWorkflowTaskRequest[],
): boolean {
  if (tasks.some((task) => task.entry.entryPoint === "receive")) return false;
  const starting = tasks.filter(
    (task) => task.entry.entryPoint !== "execute" && runEntryToStart(table, task) !== undefined,
  );
  return hasTaskSlots(table, starting.length);
}

function runningTasks(table: TaskTable): readonly TaskRecord[] {
  return workingTasks(table).filter((candidate) => candidate.run !== undefined);
}

/** Whether the task cap leaves room to run `count` more tasks. */
function hasTaskSlots(table: TaskTable, count: number): boolean {
  return runningTasks(table).length + count <= MAX_WORKING_TASKS;
}

/** The `TOO_MANY_TASKS` error when the session already runs as many tasks as it may. */
function tooManyTasks(
  input: TaskDispatchInput,
  table: TaskTable,
): RuntimeToolResultActionResult | undefined {
  if (hasTaskSlots(table, 1)) return undefined;
  const runningIds = runningTasks(table).map((candidate) => candidate.id);
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    isError: true,
    output: {
      code: TOO_MANY_TASKS_CODE,
      message: renderTooManyTasksError(MAX_WORKING_TASKS, runningIds),
    },
    toolName: input.task.toolName,
  });
}

function unknownTaskResult(input: TaskDispatchInput): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    isError: true,
    output: {
      code: UNKNOWN_TASK_CODE,
      message: renderUnknownTaskError(input.taskId, input.task.toolName),
    },
    toolName: input.task.toolName,
  });
}

function taskStartedEvent(
  input: TaskDispatchInput,
  record: TaskRecord,
): TaskStartedStreamEvent["data"] {
  return {
    callId: input.task.callId,
    kind: record.kind,
    name: input.task.toolName,
    taskId: input.taskId,
    turnId: input.batchEvent.turnId,
  };
}

function startReceipt(input: TaskDispatchInput, resumable: boolean): RuntimeToolResultActionResult {
  const receipt = renderTaskReceipt({ id: input.taskId, resumable, tool: input.task.toolName });
  return toolResult(input, receipt);
}

function toolResult(input: TaskDispatchInput, output: string): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    output,
    toolName: input.task.toolName,
  });
}
