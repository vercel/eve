import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  getBackgroundWorkflowToolRuns,
  readWorkflowTaskView,
} from "#harness/workflow-tool-runs.js";
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

/** A terminal task may still report settlement, but cannot produce another model notification. */
export function isSettledTaskDelivery(
  delivery: DeliverHookPayload,
  state: SessionStateMap | undefined,
): boolean {
  const deliveryId = delivery.taskDeliveryId;
  if (deliveryId === undefined) return false;
  return getBackgroundWorkflowToolRuns(state).some(
    ({ task }) =>
      readWorkflowTaskView(task) !== undefined &&
      (deliveryId === task.taskId || deliveryId.startsWith(`${task.taskId}:`)),
  );
}
