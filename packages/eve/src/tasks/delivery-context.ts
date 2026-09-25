import type { TaskDeliveryPolicy, DeliverHookPayload } from "#channel/types.js";
import { markFrameworkStepInput } from "#harness/messages.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import { getBackgroundTasks, type BackgroundTask } from "#harness/workflow-tool-runs.js";
import { taskIdOfDelivery } from "#tasks/notification.js";

export const TASK_DELIVERY_CONTEXT_LABEL = "[Task state]";

export const TASK_DELIVERY_INITIATING_INSTRUCTION = `Background task reporting: launch acknowledgement
The latest ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists background tasks accepted so far from the current turn. They continue independently after this turn.

Continue carrying out the user's request, including starting any remaining background work. When no further tool calls are needed in this turn, send one brief user-facing acknowledgement that the background work has started. Do not wait for results or report results that are not available yet. End the turn after the acknowledgement.`;

export const TASK_DELIVERY_SETTLED_INSTRUCTION = `Background task reporting\nFor this background-task update, the accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists the settled tasks in this cohort and their available terminal outputs. Report their useful results together in one user-facing response without repeating results already reported. Do not reply with ${EMPTY_DELIVERY_SENTINEL}.`;

export const TASK_DELIVERY_AUTO_INSTRUCTION = `Background task reporting\nFor this background-task update, the accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists the whole cohort, including pending tasks and every available terminal output. A received result has not necessarily been reported to the user. Report new results only when they are useful independently of unfinished work. When that work settles, combine its results with any previously withheld results. If there is nothing new and useful to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL}. Do not repeat results already reported or send an acknowledgement just to say you are waiting.`;

type BackgroundTaskDelivery = DeliverHookPayload & {
  readonly taskDeliveryId: string;
};

/** Returns task delivery provenance when a child task wakes its parent. */
export function getBackgroundTaskDelivery(input: unknown): BackgroundTaskDelivery | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const delivery = input as { readonly kind?: unknown; readonly taskDeliveryId?: unknown };
  return delivery.kind === "deliver" && typeof delivery.taskDeliveryId === "string"
    ? (input as BackgroundTaskDelivery)
    : undefined;
}

/** Marks a task-produced user message before the harness coalesces delivery results. */
export function markBackgroundTaskStepInput(input: StepInput): StepInput {
  return input.message === undefined
    ? input
    : markFrameworkStepInput(input, "execution.background_task");
}

/** Projects the report group without changing the delivered task's activity root. */
export function resolveTaskDeliveryContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryIds: readonly string[];
  readonly taskDeliveryPolicy: TaskDeliveryPolicy;
}):
  | {
      readonly context: string;
      readonly phase: "pending" | "settled";
      readonly rootTurnId: string;
    }
  | undefined {
  const firstDeliveryId = input.taskDeliveryIds[0];
  if (firstDeliveryId === undefined) return undefined;
  const tasks = getBackgroundTasks(input.state);
  const delivered = tasks.get(taskIdOfDelivery(firstDeliveryId));
  if (delivered === undefined) return undefined;
  return {
    ...projectTaskCohort(
      tasks.query({ cohortId: delivered.cohortId }),
      input.taskDeliveryPolicy === "auto",
    ),
    rootTurnId: delivered.run.task.requestId ?? delivered.turnId,
  };
}

/** Returns model context for durable tasks launched by the active parent turn. */
export function resolveInitiatingTaskContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly turnId: string;
}): { readonly context: string; readonly phase: "initiating" } | undefined {
  const tasks = getBackgroundTasks(input.state);
  if (tasks.query({ state: "working", turnId: input.turnId }).length === 0) return undefined;
  return {
    ...projectTaskCohort(tasks.query({ turnId: input.turnId }), false),
    phase: "initiating",
  };
}

function projectTaskCohort(
  cohort: readonly BackgroundTask[],
  includePartialOutputs: boolean,
): {
  readonly context: string;
  readonly phase: "pending" | "settled";
} {
  const settled = cohort.every((task) => task.status !== "working");
  const tasks = cohort.map((task) => ({
    name: task.metadata.name,
    output: settled || includePartialOutputs ? task.lastOutput : undefined,
    // The model-facing projection names unsettled work "pending".
    status: task.status === "working" ? "pending" : task.status,
    taskId: task.taskId,
  }));

  return {
    context: `${TASK_DELIVERY_CONTEXT_LABEL}\n${JSON.stringify({ tasks })}`,
    phase: settled ? "settled" : "pending",
  };
}
