import { sleep } from "#compiled/@workflow/core/index.js";

import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  type TaskCancelResult,
  type TaskKernelCall,
  type TaskWaitResult,
} from "#execution/tasks/calls.js";
import { renderTaskWaitResult, renderUnknownTaskError } from "#execution/tasks/render.js";
import {
  applyTaskRunMessageStep,
  cancelTasksStep,
  hardStopOverdueTasksStep,
  type TaskRunMessage,
} from "#execution/tasks/steps.js";
import {
  findTask,
  isTaskWorking,
  readTaskTable,
  taskToolName,
  tasksWithResults,
  workingTasks,
  type TaskTable,
} from "#execution/tasks/table.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { RuntimeActionResult, RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";

/** Whether a run's message changes a task record. */
export function isTaskRunMessage(message: WorkflowToolRunMessage): message is TaskRunMessage {
  if (message.from.taskId === undefined) return false;
  return message.kind === "started" || message.kind === "reply" || message.kind === "outcome";
}

/**
 * One `task_wait` call the turn is parked on. Its timeout is a durable sleep
 * the turn races against the inbox; nothing polls.
 */
export class TaskWait {
  readonly call: Extract<TaskKernelCall, { readonly kind: "task_wait" }>;
  readonly startedAtMs: number;
  /** Resolves with the call's id once the timeout passes; absent without a timeout. */
  readonly timer?: Promise<string>;
  /** A timeout of 0 has passed already: the wait returns whatever is ready. */
  timedOut: boolean;

  constructor(call: Extract<TaskKernelCall, { readonly kind: "task_wait" }>) {
    this.call = call;
    this.startedAtMs = Date.now();
    this.timedOut = call.timeoutMs === 0;
    if (call.timeoutMs !== undefined && call.timeoutMs > 0) {
      this.timer = sleep(call.timeoutMs).then(() => call.callId);
    }
  }
}

/**
 * The session's view of its tasks from the workflow body. Records change only
 * through the kernel's steps; this class decides when to run them and what
 * the kernel's calls return.
 */
export class SessionTasks {
  private readonly cursor: SessionStateCursor;
  private readonly inbox: string;

  constructor(input: { readonly cursor: SessionStateCursor; readonly inbox: string }) {
    this.cursor = input.cursor;
    this.inbox = input.inbox;
  }

  private get table(): TaskTable {
    return readTaskTable(this.cursor.sessionState.snapshot.session.state);
  }

  async handleRunMessage(message: TaskRunMessage): Promise<void> {
    await this.cursor.apply(
      await applyTaskRunMessageStep({
        message,
        sessionState: this.cursor.sessionState,
        sessionWritable: this.cursor.sessionWritable,
      }),
    );
  }

  /** `session.cancel()`: every working task. */
  async cancelAll(): Promise<void> {
    await this.cancel(workingTasks(this.table).map((record) => record.id));
  }

  /** A turn that ends anyway, such as by failing, cancels the tasks it held on. */
  async cancelWorking(principal: string): Promise<void> {
    await this.cancel(workingTasks(this.table, principal).map((record) => record.id));
  }

  hasWorkingTasks(): boolean {
    return workingTasks(this.table).length > 0;
  }

  async hardStopOverdue(): Promise<void> {
    await this.cursor.apply(
      await hardStopOverdueTasksStep({ inbox: this.inbox, sessionState: this.cursor.sessionState }),
    );
  }

  /**
   * What a wait on the principal's tasks returns now, or `undefined` to keep
   * waiting. A waiting result, or nothing left working, ends it first;
   * cancelled work never does.
   */
  waitResult(
    principal: string,
    wake: { readonly interrupted: boolean; readonly timedOut: boolean },
  ): TaskWaitResult | undefined {
    const table = this.table;
    const settled = tasksWithResults(table, principal).map((record) => record.id);
    const working = workingTasks(table, principal).map((record) => record.id);
    if (settled.length > 0 || working.length === 0) return { settled, status: "settled", working };
    if (wake.interrupted) return { status: "interrupt", working };
    if (wake.timedOut) return { status: "timeout", working };
    return undefined;
  }

  /** The `task_wait` call's result: text naming what settled and what still works. */
  waitCallResult(wait: TaskWait, result: TaskWaitResult): RuntimeActionResult {
    const table = this.table;
    const settledStatus = new Map<string, "completed" | "failed">();
    if (result.status === "settled") {
      for (const taskId of result.settled) {
        const status = findTask(table, taskId)?.results.at(-1)?.status;
        if (status !== undefined) settledStatus.set(taskId, status);
      }
    }
    const text = renderTaskWaitResult(result, {
      settledStatus,
      waitedMs: Date.now() - wait.startedAtMs,
    });
    return kernelCallResult(wait.call.callId, TASK_WAIT_TOOL_NAME, text);
  }

  /** Answers `task_cancel`, which accepts only the task creator's principal. */
  async cancelCall(
    call: Extract<TaskKernelCall, { readonly kind: "task_cancel" }>,
    principal: string,
  ): Promise<RuntimeActionResult> {
    const record = findTask(this.table, call.taskId);
    if (record === undefined || record.creator !== principal) {
      const error = {
        code: "UNKNOWN_TASK",
        message: renderUnknownTaskError(call.taskId, taskToolName(call.taskId)),
      };
      return { ...kernelCallResult(call.callId, TASK_CANCEL_TOOL_NAME, error), isError: true };
    }
    let result: TaskCancelResult = { status: "already_finished" };
    if (isTaskWorking(record)) {
      await this.cancel([record.id]);
      result = { status: "cancelled" };
    }
    return kernelCallResult(call.callId, TASK_CANCEL_TOOL_NAME, result);
  }

  private async cancel(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    await this.cursor.apply(
      await cancelTasksStep({
        inbox: this.inbox,
        sessionState: this.cursor.sessionState,
        sessionWritable: this.cursor.sessionWritable,
        taskIds,
      }),
    );
  }
}

// Built directly: the workflow body can't import the harness's result helpers.
function kernelCallResult(
  callId: string,
  toolName: string,
  output: JsonValue,
): RuntimeToolResultActionResult {
  return { callId, kind: "tool-result", output, toolName };
}
