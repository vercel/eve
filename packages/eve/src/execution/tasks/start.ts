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
  MAX_WORKING_TASKS,
  readTaskTable,
  recordTaskCall,
  recordTaskRun,
  removeTask,
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
import type { TaskCallStart } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { isWorking, tasks } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { TOO_MANY_TASKS_CODE, UNKNOWN_TASK_CODE } from "#protocol/task-tools.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolRunEntry,
} from "#shared/action-types.js";

const log = createLogger("execution.tasks");

type TaskDispatchInput = StartWorkflowTaskInput & { readonly taskId: string };

/** The call's answer, and the task start the dispatch reports for it. */
interface TaskDispatchResult {
  readonly result: RuntimeToolResultActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskCallStart;
  /** A dispatch admission refused the call before any run started. Not inferred from output. */
  readonly refusal?: "task-limit" | "task-unavailable";
}

/** The entry of a run that does a task's work. */
type TaskRunEntry = Extract<WorkflowToolRunEntry, { readonly taskId: string }>;

/**
 * Starts the run for a task its model step committed, once, and answers the
 * call with its receipt and the `task.started` data the next step publishes.
 * Runs inside the dispatch step, where the task's cap is enforced: past it,
 * the record is dropped and the call fails.
 */
export async function startTaskRun(
  input: StartWorkflowTaskInput & { readonly entry: TaskRunEntry },
  admissionView = storedProjection(input.session.state).view,
): Promise<TaskDispatchResult> {
  const { entry, session, task } = input;
  const { taskId } = entry;
  const dispatch = { ...input, taskId };
  const receipt = startReceipt(dispatch, entry.entryPoint === "serve");
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  // Cancelled before the session could start it: there is nothing to run.
  if (admissionView.calls[task.callId]?.status === "settled") return { result: receipt, session };
  if (record === undefined)
    return {
      result: startFailureResult(task, new Error(`Task dispatch record ${taskId} is unavailable.`)),
      session,
    };

  const overCap = tooManyTasks(dispatch, admissionView);
  if (overCap !== undefined) {
    return {
      result: overCap,
      refusal: "task-limit",
      session: writeTaskTable(session, removeTask(table, taskId)),
    };
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
    started: taskCallStart(dispatch, record),
  };
}

/**
 * Sends a call to the `serve` task it names by `taskId`. The task must be
 * available to the tool, and a call that makes an idle task work again
 * counts toward the cap. The call is recorded, reported as started, and sent
 * to the task's run, whose body receives it from `receive()`.
 */
export async function sendToTask(
  input: TaskDispatchInput,
  admissionView = storedProjection(input.session.state).view,
): Promise<TaskDispatchResult> {
  const { session, task, taskId } = input;
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  if (
    admissionView.tasks[taskId]?.status !== "running" ||
    !isTaskAvailable(record, task.toolName)
  ) {
    return { result: unknownTaskResult(input), refusal: "task-unavailable", session };
  }

  if (!isWorking(admissionView, taskId)) {
    const overCap = tooManyTasks(input, admissionView);
    if (overCap !== undefined) return { result: overCap, refusal: "task-limit", session };
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
    started: taskCallStart(input, record),
  };
}

/**
 * The entry of the run that dispatching `task` starts, or `undefined` when it
 * starts none: a call to a running task, or a task cancelled before the
 * session could start it. The task cap can still refuse a task's run.
 */
export function runEntryToStart(
  table: TaskTable,
  view: SessionView,
  task: RuntimeWorkflowTaskRequest,
): WorkflowToolRunEntry | undefined {
  const { entry } = task;
  switch (entry.entryPoint) {
    case "execute":
      return { entryPoint: "execute" };
    case "task":
    case "serve":
      return findTask(table, entry.taskId) === undefined ||
        view.calls[task.callId]?.status === "settled"
        ? undefined
        : entry;
    case "receive":
      return undefined;
  }
}

/**
 * Whether dispatching `tasks` in order starts every run {@link runEntryToStart}
 * names. A call to a running task can take a slot under the task cap, and
 * sending to it can fail the batch, so such a batch never qualifies.
 */
export function startsEveryRun(
  table: TaskTable,
  view: SessionView,
  tasks: readonly RuntimeWorkflowTaskRequest[],
): boolean {
  if (tasks.some((task) => task.entry.entryPoint === "receive")) return false;
  const starting = tasks.filter(
    (task) =>
      task.entry.entryPoint !== "execute" && runEntryToStart(table, view, task) !== undefined,
  );
  return workingTasks(view).length + starting.length <= MAX_WORKING_TASKS;
}

function workingTasks(view: SessionView) {
  return tasks(view, { status: "working" });
}

/** The `TOO_MANY_TASKS` error when the session already runs as many tasks as it may. */
function tooManyTasks(
  input: TaskDispatchInput,
  view: SessionView,
): RuntimeToolResultActionResult | undefined {
  const running = workingTasks(view);
  if (running.length < MAX_WORKING_TASKS) return undefined;
  const runningIds = running.map((candidate) => candidate.taskId);
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

function taskCallStart(input: TaskDispatchInput, record: TaskRecord): TaskCallStart {
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
