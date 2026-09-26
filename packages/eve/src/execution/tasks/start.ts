import { renderTaskReceipt, renderTooManyTasksError } from "#execution/tasks/render.js";
import {
  findTask,
  isTaskWorking,
  MAX_WORKING_TASKS,
  readTaskTable,
  recordTaskRun,
  removeTask,
  workingTasks,
  writeTaskTable,
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
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { RuntimeSession } from "#subagents/handle-dispatch.js";

const log = createLogger("execution.tasks");

/**
 * Starts the run for a task its model step committed, once, and answers the
 * call with its receipt. Runs inside the session's dispatch step, where the
 * task's cap is enforced: past it, the record is dropped and the call fails.
 */
export async function startTaskRun(
  input: StartWorkflowTaskInput & {
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly taskId: string;
  },
): Promise<{ readonly result: RuntimeToolResultActionResult; readonly session: RuntimeSession }> {
  const { session, task, taskId } = input;
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  // Cancelled before the session could start it: there is nothing to run.
  if (record === undefined || !isTaskWorking(record)) {
    return { result: receipt(input), session };
  }

  const running = workingTasks(table).filter((candidate) => candidate.run !== undefined);
  if (running.length >= MAX_WORKING_TASKS) {
    const result = createRuntimeToolResultFromValue({
      callId: task.callId,
      isError: true,
      output: {
        code: "TOO_MANY_TASKS",
        message: renderTooManyTasksError(
          MAX_WORKING_TASKS,
          running.map((candidate) => candidate.id),
        ),
      },
      toolName: task.toolName,
    });
    return { result, session: writeTaskTable(session, removeTask(table, taskId)) };
  }

  let address;
  try {
    address = await startWorkflowToolCallRun(input);
  } catch (error) {
    logError(log, "task run failed to start", error, { taskId, toolName: task.toolName });
    return {
      result: startFailureResult(task, error),
      session: writeTaskTable(session, removeTask(table, taskId)),
    };
  }

  await writeSessionEvent(
    input.sessionWritable,
    createTaskStartedEvent({
      callId: task.callId,
      name: task.toolName,
      taskId,
      turnId: input.batchEvent.turnId,
    }),
  );
  return {
    result: receipt(input),
    session: writeTaskTable(session, recordTaskRun(table, taskId, address)),
  };
}

function receipt(input: {
  readonly task: StartWorkflowTaskInput["task"];
  readonly taskId: string;
}): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    output: renderTaskReceipt(input.taskId),
    toolName: input.task.toolName,
  });
}
