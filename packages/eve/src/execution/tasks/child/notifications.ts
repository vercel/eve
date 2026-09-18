import type { SessionCommand } from "#channel/types.js";
import { deliverTaskNotificationStep } from "#execution/tasks/child/steps.js";
import type {
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunRequestMessage,
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
} from "#tasks/types.js";

/**
 * Wakes the parent session with a framework task notification.
 *
 * Rides the ordinary session delivery path: a parked parent starts a
 * turn carrying this message, while an active turn observes it at the
 * next safe boundary through the owner's normal delivery routing. A
 * parent whose session already ended is a tolerated no-op.
 */
export async function notifyTaskParent(input: {
  readonly token: string;
  readonly view: TaskView;
  readonly update?: { readonly report: WorkflowToolRunReport; readonly index: number };
}): Promise<void> {
  const { view, update } = input;
  let command: SessionCommand;
  if (update === undefined) {
    const payload: { message: string; task?: { views: readonly TaskView[] } } = {
      message: formatTaskNotification(view),
    };
    if (isTerminalTaskStatus(view.status)) payload.task = { views: [view] };
    command = {
      kind: "send",
      payload,
      taskDeliveryId: `${view.taskId}:ready:${view.status}`,
    };
  } else {
    command = {
      kind: "send",
      payload: {
        message: `Background task ${view.taskId} (${view.metadata.name}) update: ${formatTaskOutput(update.report.update)}`,
      },
      taskDeliveryId: `${view.taskId}:update:${view.taskId}:${update.index}:${update.report.from.callId}`,
    };
  }
  await deliverTaskNotificationStep({ token: input.token, command });
}

/** Forwards one agent spawn or settlement request to the parent session. */
export async function notifyTaskAgentRequest(input: {
  readonly request: WorkflowToolRunRequestMessage;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  const request = input.request.request;
  if (request.kind !== "agent-invoke" && request.kind !== "agent-settled") {
    throw new Error("Cannot forward task input as an agent request.");
  }
  const delivery: TaskAgentRequestDelivery = {
    replyTo: input.request.replyTo,
    request,
    taskId: input.taskId,
  };
  const invocationId =
    request.kind === "agent-invoke" ? request.invocationId : `${request.result.callId}:settled`;
  const command: SessionCommand = {
    kind: "send",
    payload: { task: { agentRequests: [delivery] } },
    taskDeliveryId: `${input.taskId}:agent:${input.request.from.runId}:${invocationId}`,
  };
  await deliverTaskNotificationStep({ token: input.token, command });
}

/** Re-emits a task child's authorization event through the parent channel. */
export async function notifyTaskAuthorization(input: {
  readonly request: WorkflowToolAuthorizationRequest;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  const { event: hookPayload } = input.request;
  const data = hookPayload.event.data;
  const payload: {
    message?: string;
    task: { authorizationEvents: TaskAuthorizationEventDelivery[] };
  } = { task: { authorizationEvents: [{ hookPayload, taskId: input.taskId }] } };
  if (hookPayload.event.type === "authorization.required") {
    payload.message = `Background task ${input.taskId} needs authorization.`;
  }
  const command: SessionCommand = {
    kind: "send",
    payload,
    taskDeliveryId: `${input.taskId}:authorization:${hookPayload.event.type}:${data.turnId}:${data.stepIndex}:${data.sequence}:${taskAuthorizationRequestId(hookPayload.event)}`,
  };
  await deliverTaskNotificationStep({ token: input.token, command });
}

/** Sends a workflow-body question to the owning parent's pre-model router. */
export async function notifyTaskInputRequest(input: {
  readonly request: WorkflowToolRunRequestMessage;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  const coordinates = input.request.requestCoordinates ?? input.request.from;
  const requests = workflowToolRunInputRequests(input.request);
  const delivery: TaskInputRequestDelivery = {
    replyTo: input.request.replyTo,
    requests,
    sequence: coordinates.sequence,
    stepIndex: coordinates.stepIndex,
    taskId: input.taskId,
    turnId: coordinates.turnId,
  };
  const command: SessionCommand = {
    kind: "send",
    payload: {
      task: {
        inputRequests: [delivery],
      },
    },
    taskDeliveryId: `${input.taskId}:input:${coordinates.turnId}:${coordinates.stepIndex}:${coordinates.sequence}`,
  };
  await deliverTaskNotificationStep({ token: input.token, command });
}
