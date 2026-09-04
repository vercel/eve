import type { TaskRunWorkflowInput } from "#execution/tasks/child/workflow.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import {
  startWorkflowOnCurrentDeployment,
  taskRunWorkflowReference,
} from "#execution/workflow-runtime.js";
import { readWorkflowOwnership } from "#execution/workflow-lifecycle.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import {
  TASK_VIEW_STREAM_NAMESPACE,
  type TaskCommand,
  type TaskCommandHookPayload,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

const TASK_VIEW_READ_TIMEOUT_MS = 10_000;

/**
 * Node-side controls for durable task runs — the generic transport layer.
 * This module only speaks `TaskCommand`/`TaskView`; it knows nothing about
 * executor implementations, receipts, or the session index. Caller-specific
 * policy composes these primitives.
 *
 * Every export must be called from inside a `"use step"` body; none of
 * these are steps themselves so dispatch and tool steps can compose them
 * inside one durable boundary.
 */

/** Starts the durable run owning one task's lifecycle. */
export async function startTaskRun(
  input: TaskRunWorkflowInput,
): Promise<{ readonly runId: string }> {
  const run = await startWorkflowOnCurrentDeployment(taskRunWorkflowReference, [input]);
  return await readWorkflowOwnership(run.runId);
}

/** Submits a command to an acknowledged task; `unreachable` means it has retired its hook. */
export async function sendTaskCommand(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
}): Promise<"delivered" | "unreachable"> {
  return (await sendTaskCommandToOwner(input)) === undefined ? "unreachable" : "delivered";
}

/** Delivers one command and returns the accepting task workflow's run id. */
export async function sendTaskCommandToOwner(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
}): Promise<{ readonly runId: string } | undefined> {
  const payload: TaskCommandHookPayload = { command: input.command, kind: "task-command" };
  try {
    const owner = await resumeHook(input.taskInboxToken, payload);
    if (
      typeof owner !== "object" ||
      owner === null ||
      !("runId" in owner) ||
      typeof owner.runId !== "string"
    ) {
      throw new Error(`Task inbox hook "${input.taskInboxToken}" returned no owner run id.`);
    }
    return { runId: owner.runId };
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
    return undefined;
  }
}

/**
 * Hands one non-command inbound payload to a task run.
 *
 * Used for payloads the run must act on before it may record them —
 * today only answered input batches, which it forwards to the child
 * first. `unreachable` means the task already finished and disposed its
 * hook, so the payload is stale by definition.
 */
export async function sendTaskInboundPayload(input: {
  readonly taskInboxToken: string;
  readonly payload: TaskRunInboundPayload;
}): Promise<"delivered" | "unreachable"> {
  try {
    await resumeHook(input.taskInboxToken, input.payload);
    return "delivered";
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) {
      throw error;
    }
    return "unreachable";
  }
}

/**
 * Reads the latest view a task run has published, or `undefined`
 * when the run has not committed its first view yet (the caller
 * already holds the creation receipt, which is `working`).
 *
 * Views are trusted without re-validation: the task run is the
 * single writer and every write passed the transition function.
 */
export async function readLatestTaskView(input: {
  readonly taskRunId: string;
}): Promise<TaskView | undefined> {
  const stream = getRun<unknown>(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_VIEW_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const tailIndex = await stream.getTailIndex();
  const reader = stream.getReader();
  try {
    if (tailIndex < 0) {
      return undefined;
    }
    const result = await readWithTimeout(reader, "latest task view");
    return result;
  } finally {
    await reader.cancel("eve task view read complete").catch(() => {});
    reader.releaseLock();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<TaskView>,
  what: string,
): Promise<TaskView | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), TASK_VIEW_READ_TIMEOUT_MS);
      }),
    ]);
    if (result.kind === "timeout") {
      throw new Error(`Timed out reading ${what} after ${TASK_VIEW_READ_TIMEOUT_MS}ms.`);
    }
    if (result.read.done) {
      return undefined;
    }
    return result.read.value;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
