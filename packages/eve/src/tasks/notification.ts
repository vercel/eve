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
