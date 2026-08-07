import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { TaskRunWorkflowInput } from "#execution/tasks/run-workflow.js";
import {
  startWorkflowPreferLatest,
  taskRunWorkflowReference,
} from "#execution/workflow-runtime.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";
import {
  TASK_SNAPSHOT_STREAM_NAMESPACE,
  isReadyTaskStatus,
  type TaskCommand,
  type TaskCommandHookPayload,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

const TASK_SNAPSHOT_READ_TIMEOUT_MS = 10_000;

/**
 * Node-side controls for durable task runs. Every export must be called
 * from inside a `"use step"` body; none of these are steps themselves so
 * dispatch and tool steps can compose them inside one durable boundary.
 */

/** Starts the durable run owning one task's lifecycle. */
export async function startTaskRun(
  input: TaskRunWorkflowInput,
): Promise<{ readonly runId: string }> {
  const run = await startWorkflowPreferLatest(taskRunWorkflowReference, [input]);
  return { runId: run.runId };
}

/**
 * Submits one command to a task run.
 *
 * `unreachable` means the hook is not resumable — either the run
 * already finished and disposed it (the task is terminal; read the
 * final snapshot) or, right after creation, the freshly started run has
 * not registered it yet. Senders racing that startup window pass
 * `retryUnreachable`; senders addressing an established task treat
 * `unreachable` as the terminal signal.
 */
export async function sendTaskCommand(input: {
  readonly command: TaskCommand;
  readonly commandToken: string;
  readonly retryUnreachable?: { readonly attempts: number; readonly delayMs: number };
}): Promise<"delivered" | "unreachable"> {
  return (await sendTaskCommandToOwner(input)) === undefined ? "unreachable" : "delivered";
}

/** Delivers one command and returns the accepting task workflow's run id. */
export async function sendTaskCommandToOwner(input: {
  readonly command: TaskCommand;
  readonly commandToken: string;
  readonly retryUnreachable?: { readonly attempts: number; readonly delayMs: number };
}): Promise<{ readonly runId: string } | undefined> {
  const payload: TaskCommandHookPayload = { command: input.command, kind: "task-command" };
  const attempts = Math.max(1, input.retryUnreachable?.attempts ?? 1);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const owner = await resumeHook(input.commandToken, payload);
      if (
        typeof owner !== "object" ||
        owner === null ||
        !("runId" in owner) ||
        typeof owner.runId !== "string"
      ) {
        throw new Error(`Task command hook "${input.commandToken}" returned no owner run id.`);
      }
      return { runId: owner.runId };
    } catch (error) {
      if (!isFinishedTaskRunTarget(error)) {
        throw error;
      }
      if (attempt + 1 >= attempts) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, input.retryUnreachable?.delayMs ?? 250));
    }
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
  readonly commandToken: string;
  readonly payload: TaskRunInboundPayload;
}): Promise<"delivered" | "unreachable"> {
  try {
    await resumeHook(input.commandToken, input.payload);
    return "delivered";
  } catch (error) {
    if (!isFinishedTaskRunTarget(error)) {
      throw error;
    }
    return "unreachable";
  }
}

/**
 * Reads the latest snapshot a task run has published, or `undefined`
 * when the run has not committed its first snapshot yet (the caller
 * already holds the creation receipt, which is `working`).
 *
 * Snapshots are trusted without re-validation: the task run is the
 * single writer and every write passed the transition function.
 */
export async function readLatestTaskSnapshot(input: {
  readonly taskRunId: string;
}): Promise<TaskView | undefined> {
  const stream = getRun<unknown>(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_SNAPSHOT_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const tailIndex = await stream.getTailIndex();
  const reader = stream.getReader();
  try {
    if (tailIndex < 0) {
      return undefined;
    }
    const result = await readWithTimeout(reader, "latest task snapshot");
    return result;
  } finally {
    await reader.cancel("eve task snapshot read complete").catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Waits until a task run publishes a ready snapshot — terminal or
 * `input_required` — starting from the latest published state. Returns
 * immediately when the task is already ready.
 *
 * Unlike {@link readLatestTaskSnapshot} this read has no timeout; the
 * caller owns cancellation by racing this promise (for example against
 * turn cancellation) and abandoning it.
 */
export async function waitForReadyTaskSnapshot(input: {
  readonly taskRunId: string;
}): Promise<TaskView> {
  const stream = getRun<unknown>(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_SNAPSHOT_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        throw new Error(
          `Task run "${input.taskRunId}" closed its snapshot stream without a ready snapshot.`,
        );
      }
      if (isReadyTaskStatus(value.status)) {
        return value;
      }
    }
  } finally {
    await reader.cancel("eve task snapshot wait complete").catch(() => {});
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
        timeout = setTimeout(() => resolve({ kind: "timeout" }), TASK_SNAPSHOT_READ_TIMEOUT_MS);
      }),
    ]);
    if (result.kind === "timeout") {
      throw new Error(`Timed out reading ${what} after ${TASK_SNAPSHOT_READ_TIMEOUT_MS}ms.`);
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

export function isFinishedTaskRunTarget(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      HookNotFoundError.is(candidate) ||
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}
