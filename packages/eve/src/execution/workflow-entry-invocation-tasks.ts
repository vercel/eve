import type { HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

/** Records tasks created by the dispatched turn and terminal task deliveries for its cohort. */
export function observeInvocationTasks(input: {
  readonly delivery: HookPayload;
  readonly pendingTaskIds: Set<string>;
  readonly sessionState: DurableSessionState;
  readonly turnId: string;
}): void {
  const taskCohorts = getSessionTaskCohorts(input.sessionState.snapshot?.session.state);
  for (const [taskId, task] of taskCohorts) {
    if (task.createdByTurnId === input.turnId) input.pendingTaskIds.add(taskId);
  }

  const taskId = terminalTaskDeliveryId(input.delivery);
  if (taskId === undefined) return;
  const deliveredTask = taskCohorts.get(taskId);
  if (deliveredTask?.settled !== true) return;

  for (const [candidateId, candidate] of taskCohorts) {
    if (
      input.pendingTaskIds.has(candidateId) &&
      candidate.settled &&
      candidate.cohortId === deliveredTask.cohortId
    ) {
      input.pendingTaskIds.delete(candidateId);
    }
  }
}

function terminalTaskDeliveryId(delivery: HookPayload): string | undefined {
  if (delivery.kind !== "deliver") return undefined;
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const suffix = `:ready:${status}`;
    if (delivery.taskDeliveryId?.endsWith(suffix)) {
      return delivery.taskDeliveryId.slice(0, -suffix.length);
    }
  }
  return undefined;
}
