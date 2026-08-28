import { getWritable } from "#compiled/@workflow/core/index.js";
import type {
  ActivityObserverConfig,
  SessionAuthContext,
  SessionCommand,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { normalizeActivityText } from "#execution/activity-text.js";
import { submitActivity } from "#execution/submit-activity.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { createLogger } from "#internal/logging.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import type { JsonValue } from "#shared/json.js";
import {
  isTerminalTaskStatus,
  taskAuthorizationRequestId,
  TASK_VIEW_STREAM_NAMESPACE,
  type TaskInboundAnswerInput,
  type TaskInboundAuthorizationEvent,
  type TaskInboundInputRequest,
  type TaskInboundUpdate,
  type TaskView,
} from "#tasks/types.js";

const log = createLogger("execution.tasks.run");

/**
 * Appends one full task view to the owning task run's `eve.task`
 * stream. Only the task run workflow calls this, which is what makes
 * the run the single writer readers can trust without re-validating.
 */
export async function appendTaskViewStep(input: {
  readonly activityObserver?: ActivityObserverConfig;
  readonly view: TaskView;
}): Promise<void> {
  "use step";

  const writable = getWritable<TaskView>({ namespace: TASK_VIEW_STREAM_NAMESPACE });
  const writer = writable.getWriter();
  try {
    await writer.write(input.view);
  } finally {
    writer.releaseLock();
  }

  const events = projectTaskActivitySettlement({
    activityObserver: input.activityObserver,
    settledAt: new Date().toISOString(),
    view: input.view,
  });
  void submitActivity({ events, sink: input.activityObserver?.sink });
}

export function projectTaskActivitySettlement(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly settledAt: string;
  readonly view: TaskView;
}): readonly ActivityEventV1[] {
  const work = input.activityObserver?.workIdentity;
  const status = input.view.status;
  if (
    work === undefined ||
    (status !== "completed" && status !== "failed" && status !== "cancelled")
  )
    return [];
  return [
    {
      eventId: `${work.id}:settled:${status}`,
      kind: "work.settled",
      outcome: status,
      settledAt: input.settledAt,
      workId: work.id,
    },
  ];
}

/** Re-emits a task-owned child authorization event through the parent channel. */
export async function wakeTaskAuthorizationParentStep(input: {
  readonly request: TaskInboundAuthorizationEvent;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  const hookPayload: SubagentAuthorizationEventHookPayload = {
    callId: input.request.callId,
    childSessionId: input.request.childSessionId,
    event: input.request.event,
    kind: "subagent-authorization-event",
    subagentName: input.request.subagentName,
  };
  const data = input.request.event.data;
  const payload: {
    message?: string;
    task: {
      authorizationEvents: {
        hookPayload: SubagentAuthorizationEventHookPayload;
        taskId: string;
      }[];
    };
  } = { task: { authorizationEvents: [{ hookPayload, taskId: input.taskId }] } };
  if (input.request.event.type === "authorization.required") {
    payload.message = `Background task ${input.taskId} needs authorization.`;
  }
  const command: SessionCommand = {
    kind: "send",
    payload,
    taskDeliveryId: `${input.taskId}:authorization:${input.request.event.type}:${data.turnId}:${data.stepIndex}:${data.sequence}:${taskAuthorizationRequestId(input.request.event)}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
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

  const payload: { message: string; task?: { views: readonly TaskView[] } } = {
    message: formatTaskNotification(input.view),
  };
  if (isTerminalTaskStatus(input.view.status)) payload.task = { views: [input.view] };
  const command: SessionCommand = {
    kind: "send",
    payload,
    taskDeliveryId: `${input.view.taskId}:ready:${input.view.status}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) {
      log.warn("task wake target is gone; the parent session already ended", {
        status: input.view.status,
        taskId: input.view.taskId,
      });
      return;
    }
    throw error;
  }
}

/** Forwards a running child's intermediate update to its parent session. */
export async function wakeTaskUpdateParentStep(input: {
  readonly activityObserver?: ActivityObserverConfig;
  readonly token: string;
  readonly update: TaskInboundUpdate;
  readonly view: TaskView;
}): Promise<void> {
  "use step";

  void submitActivity({
    events: projectTaskUpdateActivity({
      activityObserver: input.activityObserver,
      update: input.update,
      updatedAt: new Date().toISOString(),
      view: input.view,
    }),
    sink: input.activityObserver?.sink,
  });

  const command: SessionCommand = {
    kind: "send",
    payload: {
      message: `Background task ${input.view.taskId} (${input.view.metadata.name}) update: ${input.update.message}`,
    },
    taskDeliveryId: `${input.view.taskId}:update:${input.update.updateEpoch}:${input.update.updateIndex}:${input.update.callId}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}

export function projectTaskUpdateActivity(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly update: TaskInboundUpdate;
  readonly updatedAt: string;
  readonly view: TaskView;
}): readonly ActivityEventV1[] {
  const work = input.activityObserver?.workIdentity;
  const message = normalizeActivityText(input.update.message);
  if (work === undefined || message === "" || isTerminalTaskStatus(input.view.status)) return [];
  return [
    {
      eventId: `${work.id}:updated:${input.update.updateEpoch}:${input.update.updateIndex}`,
      kind: "work.updated",
      message,
      updatedAt: input.updatedAt,
      workId: work.id,
    },
  ];
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
      task: {
        inputRequests: [
          {
            hookPayload: input.request as SubagentInputRequestHookPayload,
            taskId: input.taskId,
          },
        ],
      },
    },
    taskDeliveryId: `${input.taskId}:input:${input.request.event.turnId}:${input.request.event.stepIndex}:${input.request.event.sequence}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}

/**
 * Forwards answered input to the blocked child.
 *
 * The task run performs this itself so the child unblocks and the
 * view leaves `input_required` under one durable decision. Returns
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
      await resumeSessionInbox(input.answer.childContinuationToken, command);
    }
    return "delivered";
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) {
      log.warn("task input answer target is gone; the child turn already ended", {
        taskId: input.answer.taskId,
      });
      return "unreachable";
    }
    throw error;
  }
}

export function formatTaskNotification(view: TaskView): string {
  const subject = `Background task ${view.taskId} (${view.metadata.name})`;
  if (view.status === "input_required") {
    return `${subject} needs input.`;
  }
  if (view.status === "completed") {
    return `${subject} is completed.\n\nResult:\n${formatTaskOutput(view.lastOutput.data)}`;
  }
  if (view.status === "failed") {
    return `${subject} failed.\n\nError:\n${formatTaskOutput(view.lastOutput.data)}`;
  }
  return `${subject} is cancelled.`;
}

function formatTaskOutput(output: JsonValue): string {
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "null");
}
