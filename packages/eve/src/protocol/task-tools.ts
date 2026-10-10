import type { FactOf } from "#protocol/session-events/facts.js";

export const TASK_WAIT_TOOL_NAME = "eve__task_wait";
export const TASK_CANCEL_TOOL_NAME = "eve__task_cancel";

/** The task tools' names. */
export const TASK_TOOL_NAMES: readonly string[] = [TASK_WAIT_TOOL_NAME, TASK_CANCEL_TOOL_NAME];

/**
 * Whether a tool call is the model managing its own tasks. The stream keeps
 * these calls so evals and traces can see them, but activity surfaces hide
 * them: people see the tasks, not the model waiting on or stopping them. The
 * `eve` namespace is reserved, so no authored tool matches.
 */
export function isTaskControlTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.includes(toolName);
}

export const TOO_MANY_TASKS_CODE = "TOO_MANY_TASKS";
export const UNKNOWN_TASK_CODE = "UNKNOWN_TASK";

/**
 * A framework task admission refused the call before starting any work. The lifecycle says so;
 * an authored tool's output or error code never decides admission. Activity surfaces hide these
 * refusals while the model follows their recovery guidance.
 */
export function isTaskAdmissionRefused(event: FactOf<"call.settled">): boolean {
  const { outcome, cause } = event.data;
  return (
    outcome === "rejected" &&
    cause !== undefined &&
    "policy" in cause &&
    (cause.policy === "task-limit" || cause.policy === "task-unavailable")
  );
}
