import { principalOf } from "#execution/tasks/principal.js";
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
  type TaskTable,
} from "#execution/tasks/table.js";
import { writeSessionEvent } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import {
  startFailureResult,
  startWorkflowToolCallRun,
  type StartWorkflowTaskInput,
} from "#execution/tools/workflow/start.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { createLogger, logError } from "#internal/logging.js";
import { createTaskStartedEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult, WorkflowToolRunEntry } from "#shared/action-types.js";
import type { RuntimeSession } from "#subagents/handle-dispatch.js";

const log = createLogger("execution.tasks");

type TaskDispatchInput = StartWorkflowTaskInput & {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly taskId: string;
};

interface TaskDispatchResult {
  readonly result: RuntimeToolResultActionResult;
  readonly session: RuntimeSession;
}

/** The entry of a run that does a task's work. */
type TaskRunEntry = Extract<WorkflowToolRunEntry, { readonly taskId: string }>;

/**
 * Starts the run for a task its model step committed, once, and answers the
 * call with its receipt. Runs inside the session's dispatch step, where the
 * task's cap is enforced: past it, the record is dropped and the call fails.
 */
export async function startTaskRun(
  input: StartWorkflowTaskInput & {
    readonly entry: TaskRunEntry;
    readonly sessionWritable: WritableStream<Uint8Array>;
  },
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

  await emitTaskStarted(dispatch);
  return {
    result: receipt,
    session: writeTaskTable(session, recordTaskRun(table, taskId, address)),
  };
}

/**
 * Sends a call to the `serve` task it names by `taskId`. The task must be
 * available to the caller, and a call that makes an idle task work again
 * counts toward the cap. The call is recorded, reported as started, and sent
 * to the task's run, whose body receives it from `receive()`.
 */
export async function sendToTask(input: TaskDispatchInput): Promise<TaskDispatchResult> {
  const { session, task, taskId } = input;
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  const caller = { principal: principalOf(input.auth), toolName: task.toolName };
  if (!isTaskAvailable(record, caller)) {
    return { result: unknownTaskResult(input), session };
  }

  if (!isTaskWorking(record)) {
    const overCap = tooManyTasks(input, table);
    if (overCap !== undefined) return { result: overCap, session };
  }

  const recorded = recordTaskCall(table, taskId, {
    callId: task.callId,
    executeInput: task.executeInput,
    input: task.input,
  });
  if (recorded.send !== undefined) await sendTaskRunCommands(recorded.send);
  await emitTaskStarted(input);
  return {
    result: toolResult(input, renderTaskSentReceipt(taskId)),
    session: writeTaskTable(session, recorded.table),
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
      code: "TOO_MANY_TASKS",
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
      code: "UNKNOWN_TASK",
      message: renderUnknownTaskError(input.taskId, input.task.toolName),
    },
    toolName: input.task.toolName,
  });
}

async function emitTaskStarted(input: TaskDispatchInput): Promise<void> {
  await writeSessionEvent(
    input.sessionWritable,
    createTaskStartedEvent({
      callId: input.task.callId,
      name: input.task.toolName,
      taskId: input.taskId,
      turnId: input.batchEvent.turnId,
    }),
  );
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
