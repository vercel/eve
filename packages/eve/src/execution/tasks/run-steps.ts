import { getWritable } from "#compiled/@workflow/core/index.js";
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createLogger } from "#internal/logging.js";
import { walkCauseChain } from "#shared/errors.js";
import { TASK_SNAPSHOT_STREAM_NAMESPACE, type TaskStatus, type TaskView } from "#tasks/types.js";

const log = createLogger("execution.tasks.run");

/**
 * Appends one full task snapshot to the owning task run's `eve.task`
 * stream. Only the task run workflow calls this, which is what makes
 * the run the single writer readers can trust without re-validating.
 */
export async function appendTaskSnapshotStep(input: { readonly view: TaskView }): Promise<void> {
  "use step";

  const writable = getWritable<TaskView>({ namespace: TASK_SNAPSHOT_STREAM_NAMESPACE });
  const writer = writable.getWriter();
  try {
    await writer.write(input.view);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Wakes the parent session with a framework task notification.
 *
 * Rides the ordinary session delivery path: a parked parent starts a
 * turn carrying this message, while an active turn observes it at the
 * next safe boundary through the driver's normal delivery routing. A
 * parent whose session already ended is a tolerated no-op.
 */
export async function wakeTaskParentStep(input: {
  readonly token: string;
  readonly view: TaskView;
}): Promise<void> {
  "use step";

  const payload: DeliverHookPayload = {
    kind: "deliver",
    payloads: [
      {
        message: formatTaskNotification(input.view),
        taskNotification: {
          status: readyNotificationStatus(input.view.status),
          taskId: input.view.taskId,
        },
      },
    ],
  };
  try {
    await resumeHook(input.token, payload);
  } catch (error) {
    if (isGoneParentTarget(error)) {
      log.warn("task wake target is gone; the parent session already ended", {
        status: input.view.status,
        taskId: input.view.taskId,
      });
      return;
    }
    throw error;
  }
}

function readyNotificationStatus(status: TaskStatus): Exclude<TaskStatus, "working"> {
  if (status === "working") {
    throw new Error("Cannot wake a parent for a working task.");
  }
  return status;
}

function formatTaskNotification(view: TaskView): string {
  const subject = `Background task ${view.taskId} (${view.metadata.name})`;
  if (view.status === "input_required") {
    return `${subject} needs input. Use task_peek to inspect the outstanding requests.`;
  }
  return `${subject} is ${view.status}. Use task_peek to read its output.`;
}

function isGoneParentTarget(error: unknown): boolean {
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
