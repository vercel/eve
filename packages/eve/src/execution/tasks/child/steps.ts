import { getWritable } from "#compiled/@workflow/core/index.js";
import type { SessionAuthContext, SessionCommand } from "#channel/types.js";
import {
  isWorkflowToolEffectRequest,
  type WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunTaskInputRequest } from "./workflow.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { createLogger } from "#internal/logging.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  isTerminalTaskStatus,
  TASK_VIEW_STREAM_NAMESPACE,
  type TaskInboundAnswerInput,
  type TaskInboundUpdate,
  type TaskEffectDelivery,
  type TaskInputRequestDelivery,
  type TaskView,
} from "#tasks/types.js";

const log = createLogger("execution.tasks.run");

/**
 * Appends one full task view to the owning task run's `eve.task`
 * stream. Only the task run workflow calls this, which is what makes
 * the run the single writer readers can trust without re-validating.
 */
export async function appendTaskViewStep(input: { readonly view: TaskView }): Promise<void> {
  "use step";

  const writable = getWritable<TaskView>({ namespace: TASK_VIEW_STREAM_NAMESPACE });
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
  readonly token: string;
  readonly update: TaskInboundUpdate;
  readonly view: TaskView;
}): Promise<void> {
  "use step";

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

/** Forwards one task-owned workflow effect to the parent session. */
export async function wakeTaskEffectParentStep(input: {
  readonly request: WorkflowToolRunRequestMessage;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  const effect = input.request.request;
  if (!isWorkflowToolEffectRequest(effect)) {
    throw new Error("Cannot forward task input as a workflow effect.");
  }
  const delivery: { -readonly [K in keyof TaskEffectDelivery]: TaskEffectDelivery[K] } = {
    input: parseJsonValue(effect.input),
    name: effect.name,
    replyTo: input.request.replyTo,
    taskId: input.taskId,
  };
  if (effect.invocationId !== undefined) delivery.invocationId = effect.invocationId;
  const command: SessionCommand = {
    kind: "send",
    payload: {
      task: {
        effects: [delivery],
      },
    },
    taskDeliveryId: `${input.taskId}:effect:${input.request.from.runId}:${effect.invocationId ?? effect.name}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
  }
}

/** Sends a workflow-body question to the owning parent's pre-model router. */
export async function wakeWorkflowTaskInputRequestParentStep(input: {
  readonly request: WorkflowToolRunTaskInputRequest;
  readonly taskId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  const delivery: TaskInputRequestDelivery =
    input.request.requests === undefined
      ? {
          replyTo: input.request.replyTo,
          request: input.request.request,
          sequence: input.request.sequence,
          stepIndex: input.request.stepIndex,
          taskId: input.taskId,
          turnId: input.request.turnId,
        }
      : {
          replyTo: input.request.replyTo,
          requests: input.request.requests,
          sequence: input.request.sequence,
          stepIndex: input.request.stepIndex,
          taskId: input.taskId,
          turnId: input.request.turnId,
        };
  const command: SessionCommand = {
    kind: "send",
    payload: {
      task: {
        inputRequests: [delivery],
      },
    },
    taskDeliveryId: `${input.taskId}:input:${input.request.turnId}:${input.request.stepIndex}:${input.request.sequence}`,
  };
  try {
    await resumeSessionInbox(input.token, command);
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
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
