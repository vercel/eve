import type { ActivityObserverConfig, SessionAuthContext, SessionCommand } from "#channel/types.js";
import { submitActivity } from "#execution/submit-activity.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { createLogger } from "#internal/logging.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import type { TaskInboundAnswerInput, TaskView } from "#tasks/types.js";

const log = createLogger("execution.tasks.run");

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

/** All task notifications share delivery, retries, and ended-parent handling. */
export async function deliverTaskNotificationStep(input: {
  readonly token: string;
  readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
}): Promise<void> {
  "use step";

  try {
    await resumeSessionInbox(input.token, input.command);
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
    log.warn("task notification target is gone; the parent session already ended", {
      taskDeliveryId: input.command.taskDeliveryId,
    });
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
