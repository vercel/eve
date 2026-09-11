import type { DeliverHookPayload } from "#channel/types.js";
import { markFrameworkStepInput } from "#harness/messages.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import { getSessionTaskIndex, type SessionTaskIndexEntry } from "#tasks/session-index.js";
import { getTaskCohortId } from "#tasks/session-task-cohorts.js";

export const TASK_DELIVERY_CONTEXT_LABEL = "[Task state]";

export const TASK_DELIVERY_INITIATING_INSTRUCTION = `Background task reporting: launch acknowledgement
The latest ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists background tasks accepted so far from the current turn. They continue independently after this turn.

Continue carrying out the user's request, including starting any remaining background work. When no further tool calls are needed in this turn, send one brief user-facing acknowledgement that the background work has started. Do not wait for results or report results that are not available yet. End the turn after the acknowledgement.`;

export const TASK_DELIVERY_SETTLED_INSTRUCTION = `Background task reporting\nThis turn was triggered by background task activity. The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists overlapping background tasks in the same cohort, potentially started across different user turns, all settled, with every available terminal output. Do not reply with ${EMPTY_DELIVERY_SENTINEL}. Send one user-facing response that combines their useful results.`;

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

/** Groups overlapping tasks without changing the delivered task's activity root. */
export function resolveTaskDeliveryContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryId: string;
}):
  | {
      readonly context: string;
      readonly phase: "pending" | "settled";
      readonly rootTurnId: string;
    }
  | undefined {
  const entries = getSessionTaskIndex(input.state);
  const delivered = entries.find((entry) => input.taskDeliveryId.startsWith(`${entry.taskId}:`));
  if (delivered === undefined) return undefined;

  const cohort = entries.filter((entry) => getTaskCohortId(entry) === getTaskCohortId(delivered));
  return { ...projectTaskCohort(cohort), rootTurnId: delivered.createdByTurnId };
}

/** Returns model context for durable tasks launched by the active parent turn. */
export function resolveInitiatingTaskContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly turnId: string;
}): { readonly context: string; readonly phase: "initiating" } | undefined {
  const cohort = getSessionTaskIndex(input.state).filter(
    (entry) => entry.createdByTurnId === input.turnId,
  );
  if (!cohort.some((entry) => entry.executor !== undefined && entry.terminalView === undefined)) {
    return undefined;
  }
  return { ...projectTaskCohort(cohort), phase: "initiating" };
}

function projectTaskCohort(cohort: readonly SessionTaskIndexEntry[]): {
  readonly context: string;
  readonly phase: "pending" | "settled";
} {
  const settled = cohort.every((entry) => entry.terminalView !== undefined);
  const tasks = cohort.map((entry) => ({
    name: entry.metadata.name,
    output: settled ? entry.terminalView?.lastOutput : undefined,
    status: entry.terminalView?.status ?? "pending",
    taskId: entry.taskId,
  }));

  return {
    context: `${TASK_DELIVERY_CONTEXT_LABEL}\n${JSON.stringify({ tasks })}`,
    phase: settled ? "settled" : "pending",
  };
}
