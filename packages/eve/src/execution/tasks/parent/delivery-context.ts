import type { SessionStateMap } from "#harness/types.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

export const TASK_DELIVERY_CONTEXT_LABEL = "[Task state]";

/** Returns model context for tasks started by the same parent turn as this delivery. */
export function resolveTaskDeliveryContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryId: string;
}): string | undefined {
  const entries = getSessionTaskIndex(input.state);
  const delivered = entries.find((entry) => input.taskDeliveryId.startsWith(`${entry.taskId}:`));
  if (delivered === undefined) return undefined;

  const cohort = entries.filter((entry) => entry.createdByTurnId === delivered.createdByTurnId);
  const settled = cohort.every((entry) => entry.terminalView !== undefined);
  const tasks = cohort.map((entry) => ({
    name: entry.metadata.name,
    output: settled ? entry.terminalView?.lastOutput : undefined,
    status: entry.terminalView?.status ?? "pending",
    taskId: entry.taskId,
  }));

  return `${TASK_DELIVERY_CONTEXT_LABEL}\n${JSON.stringify({ tasks })}`;
}
