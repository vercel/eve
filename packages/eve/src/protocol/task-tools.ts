import type { FactOf } from "#protocol/session-events/facts.js";

export const TASK_WAIT_TOOL_NAME = "eve__task_wait";
export const TASK_CANCEL_TOOL_NAME = "eve__task_cancel";

export const TASK_TOOL_NAMES: readonly string[] = [TASK_WAIT_TOOL_NAME, TASK_CANCEL_TOOL_NAME];

export function isTaskControlTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.includes(toolName);
}

export const TOO_MANY_TASKS_CODE = "TOO_MANY_TASKS";
export const UNKNOWN_TASK_CODE = "UNKNOWN_TASK";

export function isTaskAdmissionRefused(call: {
  readonly outcome?: string;
  readonly cause?: FactOf<"call.settled">["data"]["cause"];
}): boolean {
  const { outcome, cause } = call;
  return (
    outcome === "rejected" &&
    cause !== undefined &&
    "policy" in cause &&
    (cause.policy === "task-limit" || cause.policy === "task-unavailable")
  );
}
