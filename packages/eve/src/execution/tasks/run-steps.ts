import { getWritable } from "#compiled/@workflow/core/index.js";
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type {
  SessionAuthContext,
  SessionCommand,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createLogger } from "#internal/logging.js";
import { walkCauseChain } from "#shared/errors.js";
import {
  isTerminalTaskStatus,
  TASK_SNAPSHOT_STREAM_NAMESPACE,
  type TaskInboundAnswerInput,
  type TaskInboundAuthorizationEvent,
  type TaskInboundInputRequest,
  type TaskView,
} from "#tasks/types.js";

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

/** Re-emits a task-owned child authorization event through the parent channel. */
export async function wakeTaskAuthorizationParentStep(input: {
  readonly request: TaskInboundAuthorizationEvent;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  const hookPayload: SubagentAuthorizationEventHookPayload = input.request;
  const data = input.request.event.data;
  const payload: {
    message?: string;
    taskAuthorizationEvents: {
      hookPayload: SubagentAuthorizationEventHookPayload;
      taskId: string;
    }[];
  } = { taskAuthorizationEvents: [{ hookPayload, taskId: input.taskId }] };
  if (input.request.event.type === "authorization.required") {
    payload.message = `Background task ${input.taskId} needs authorization.`;
  }
  const command: SessionCommand = {
    kind: "send",
    payload,
    taskDeliveryId: `${input.taskId}:authorization:${input.request.event.type}:${data.turnId}:${data.stepIndex}:${data.sequence}:${data.name}`,
  };
  try {
    await resumeHook(input.token, command);
  } catch (error) {
    if (isGoneParentTarget(error)) return;
    throw error;
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

  const payload: { message: string; taskSnapshots?: readonly TaskView[] } = {
    message: formatTaskNotification(input.view),
  };
  if (isTerminalTaskStatus(input.view.status)) payload.taskSnapshots = [input.view];
  const command: SessionCommand = {
    kind: "send",
    payload,
    taskDeliveryId: `${input.view.taskId}:ready:${input.view.status}`,
  };
  try {
    await resumeHook(input.token, command);
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

/** Sends an exact local-task HITL batch to the parent's pre-model router. */
export async function wakeTaskInputRequestParentStep(input: {
  readonly request: TaskInboundInputRequest;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  const command: SessionCommand = {
    kind: "send",
    payload: {
      taskInputRequests: [
        {
          hookPayload: input.request as SubagentInputRequestHookPayload,
          taskId: input.taskId,
        },
      ],
    },
    taskDeliveryId: `${input.taskId}:input:${input.request.event.turnId}:${input.request.event.stepIndex}:${input.request.event.sequence}`,
  };
  try {
    await resumeHook(input.token, command);
  } catch (error) {
    if (isGoneParentTarget(error)) return;
    throw error;
  }
}

/**
 * Forwards answered input to the blocked child.
 *
 * The task run performs this itself so the child unblocks and the
 * snapshot leaves `input_required` under one durable decision. Returns
 * `unreachable` when the child hook is already gone, which leaves the
 * outstanding batch untouched rather than reporting a task as working
 * when nothing received the answer.
 */
export async function deliverTaskInputResponsesStep(input: {
  readonly answer: TaskInboundAnswerInput;
  readonly requestIds: readonly string[];
}): Promise<"delivered" | "unreachable"> {
  "use step";

  const answered = new Set(input.requestIds);
  const command: SessionCommand = {
    auth: input.answer.auth as SessionAuthContext | null | undefined,
    kind: "send",
    payload: {
      inputResponses: input.answer.inputResponses.filter((response) =>
        answered.has(response.requestId),
      ),
    },
    taskDeliveryId: `${input.answer.taskId}:${[...input.requestIds].sort().join(",")}`,
  };
  try {
    if (input.answer.childResponseUrl !== undefined) {
      const response = await fetch(input.answer.childResponseUrl, {
        body: JSON.stringify({ inputResponses: command.payload.inputResponses }),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
      if (response.status === 404) return "unreachable";
      if (!response.ok)
        throw new Error(`Remote task input delivery failed with HTTP ${response.status}.`);
    } else {
      await resumeHook(input.answer.childContinuationToken, command);
    }
    return "delivered";
  } catch (error) {
    if (isGoneParentTarget(error)) {
      log.warn("task input answer target is gone; the child turn already ended", {
        taskId: input.answer.taskId,
      });
      return "unreachable";
    }
    throw error;
  }
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
