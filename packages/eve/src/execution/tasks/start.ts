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
import type { RuntimeToolResultActionResult, WorkflowToolRunEntry } from "#shared/action-types.js";

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
  const record = findTask(table, taskId);
  // Cancelled before the session could start it: there is nothing to run.
  if (record === undefined || !isTaskWorking(record)) {
    return { result: receipt, session };
  }

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

/** The `TOO_MANY_TASKS` error when the session already runs as many tasks as it may. */
function tooManyTasks(
  input: TaskDispatchInput,
  table: TaskTable,
): RuntimeToolResultActionResult | undefined {
  const running = workingTasks(table).filter((candidate) => candidate.run !== undefined);
  if (running.length < MAX_WORKING_TASKS) return undefined;
  const runningIds = running.map((candidate) => candidate.id);
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
