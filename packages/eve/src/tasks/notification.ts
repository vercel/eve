import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBackgroundTasks } from "#harness/workflow-tool-runs.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskView } from "#tasks/types.js";

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

export function formatTaskOutput(output: JsonValue): string {
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "null");
}

/** Task delivery ids are `<taskId>` or `<taskId>:<event>`; derived task ids never contain `:`. */
export function taskIdOfDelivery(deliveryId: string): string {
  const separator = deliveryId.indexOf(":");
  return separator < 0 ? deliveryId : deliveryId.slice(0, separator);
}

/** The parent already recorded this task's outcome, so the delivery cannot notify the model again. */
export function hasRecordedTaskOutcome(
  delivery: DeliverHookPayload,
  state: SessionStateMap | undefined,
): boolean {
  const deliveryId = delivery.taskDeliveryId;
  if (deliveryId === undefined) return false;
  const task = getBackgroundTasks(state).get(taskIdOfDelivery(deliveryId));
  return task !== undefined && task.status !== "working";
}
