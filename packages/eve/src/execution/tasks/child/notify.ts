import type { ActivityObserverConfig, SessionAuthContext, SessionCommand } from "#channel/types.js";
import { submitActivity } from "#execution/submit-activity.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { createLogger } from "#internal/logging.js";
import type { ActivityEventV1 } from "#protocol/activity.js";

import type {
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunReport,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunInputRequests } from "#execution/tools/workflow/owner-inbox.js";
import { formatTaskNotification, formatTaskOutput } from "#tasks/notification.js";
import {
  isTerminalTaskStatus,
  taskAuthorizationRequestId,
  type TaskAgentRequestDelivery,
  type TaskAuthorizationEventDelivery,
  type TaskInputRequestDelivery,
  type TaskView,
  type TaskInboundAnswerInput,
} from "#tasks/types.js";

const log = createLogger("execution.tasks.run");

type TaskParentNotification =
  | {
      readonly view: TaskView;
      readonly update?: { readonly report: WorkflowToolRunReport; readonly index: number };
    }
  | {
      readonly taskId: string;
      readonly request: WorkflowToolRunRequestMessage;
    };

/** Delivers task outcomes, updates, and requests through the parent's session inbox. */
export async function notifyTaskParent(
  input: TaskParentNotification & { readonly token: string },
): Promise<void> {
  "use step";

  const command = taskNotificationCommand(input);
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
    log.warn("task notification target is gone; the parent session already ended", {
      taskDeliveryId: "taskDeliveryId" in command ? command.taskDeliveryId : undefined,
    });
  }
}

function taskNotificationCommand(
  input: TaskParentNotification,
): Extract<SessionCommand, { readonly kind: "send" }> | WorkflowToolRunMessage {
  if ("view" in input) {
    const { view, update } = input;
    if (update !== undefined) {
      return {
        kind: "send",
        payload: {
          message: `Background task ${view.taskId} (${view.metadata.name}) update: ${formatTaskOutput(update.report.update)}`,
        },
        taskDeliveryId: `${view.taskId}:update:${view.taskId}:${update.index}:${update.report.from.callId}`,
      };
    }
    const payload: { message: string; task?: { views: readonly TaskView[] } } = {
      message: formatTaskNotification(view),
    };
    if (isTerminalTaskStatus(view.status)) payload.task = { views: [view] };
    return {
      kind: "send",
      payload,
      taskDeliveryId: `${view.taskId}:ready:${view.status}`,
    };
  }

  const { taskId, request: message } = input;
  const { request } = message;
  if (request.kind === "sandbox-request") {
    return {
      ...message,
      kind: "request",
      request: { kind: "sandbox-request", taskId },
    };
  }
  if (request.kind === "authorization-request") return taskAuthorizationCommand(request, taskId);
  if (request.kind === "agent-invoke" || request.kind === "agent-settled") {
    const delivery: TaskAgentRequestDelivery = { replyTo: message.replyTo, request, taskId };
    const invocationId =
      request.kind === "agent-invoke" ? request.invocationId : `${request.result.callId}:settled`;
    return {
      kind: "send",
      payload: { task: { agentRequests: [delivery] } },
      taskDeliveryId: `${taskId}:agent:${message.from.runId}:${invocationId}`,
    };
  }

  const coordinates = message.requestCoordinates ?? message.from;
  const delivery: TaskInputRequestDelivery = {
    replyTo: message.replyTo,
    requests: workflowToolRunInputRequests(message),
    sequence: coordinates.sequence,
    stepIndex: coordinates.stepIndex,
    taskId,
    turnId: coordinates.turnId,
  };
  return {
    kind: "send",
    payload: { task: { inputRequests: [delivery] } },
    taskDeliveryId: `${taskId}:input:${coordinates.turnId}:${coordinates.stepIndex}:${coordinates.sequence}`,
  };
}

function taskAuthorizationCommand(
  request: WorkflowToolAuthorizationRequest,
  taskId: string,
): Extract<SessionCommand, { readonly kind: "send" }> {
  const { event: hookPayload } = request;
  const data = hookPayload.event.data;
  const payload: {
    message?: string;
    task: { authorizationEvents: TaskAuthorizationEventDelivery[] };
  } = { task: { authorizationEvents: [{ hookPayload, taskId }] } };
  if (hookPayload.event.type === "authorization.required") {
    payload.message = `Background task ${taskId} needs authorization.`;
  }
  return {
    kind: "send",
    payload,
    taskDeliveryId: `${taskId}:authorization:${hookPayload.event.type}:${data.turnId}:${data.stepIndex}:${data.sequence}:${taskAuthorizationRequestId(hookPayload.event)}`,
  };
}

/** Emits task activity without storing a second task-state record. */
export async function emitTaskActivityStep(input: {
  readonly activityObserver?: ActivityObserverConfig;
  readonly view: TaskView;
}): Promise<void> {
  "use step";

  const events = projectTaskActivity({
    activityObserver: input.activityObserver,
    settledAt: new Date().toISOString(),
    view: input.view,
  });
  await submitActivity({ events, sink: input.activityObserver?.sink });
}

export function projectTaskActivity(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly settledAt: string;
  readonly view: TaskView;
}): readonly ActivityEventV1[] {
  const work = input.activityObserver?.workIdentity;
  if (work === undefined) return [];
  const status = input.view.status;
  if (status === "working") {
    return [
      {
        eventId: `${work.id}:started`,
        kind: "work.started",
        startedAt: input.settledAt,
        work,
      },
    ];
  }
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return [];
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
  readonly answerHook?: AnswerHookRoute;
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
    } else if (input.answerHook !== undefined) {
      await resumeWorkflowToolRunAnswers(
        input.answer.childContinuationToken,
        command.payload.inputResponses,
      );
    } else {
      await resumeSessionInbox(
        input.answer.childSessionInbox ?? input.answer.childContinuationToken,
        command,
      );
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
