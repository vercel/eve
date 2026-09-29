export const TASK_WAIT_TOOL_NAME = "task_wait";
export const TASK_CANCEL_TOOL_NAME = "task_cancel";

/** The task tools' names; authored tools cannot use them. */
export const TASK_TOOL_NAMES: readonly string[] = [TASK_WAIT_TOOL_NAME, TASK_CANCEL_TOOL_NAME];

/**
 * Whether a tool call is the model managing its own tasks. The stream keeps
 * these calls so evals and traces can see them, but activity surfaces hide
 * them: people see the tasks, not the model waiting on or stopping them. The
 * names are reserved, so no authored tool matches.
 */
export function isTaskControlTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.includes(toolName);
}

export const TOO_MANY_TASKS_CODE = "TOO_MANY_TASKS";
export const UNKNOWN_TASK_CODE = "UNKNOWN_TASK";

/** A task call the session refused for the model to retry: too many tasks, or an unknown id. */
const TASK_RETRY_ERROR_CODES: readonly string[] = [TOO_MANY_TASKS_CODE, UNKNOWN_TASK_CODE];

/**
 * Whether a tool result is a refusal only the model acts on. Its message
 * tells the model how to recover, so activity surfaces keep it out of view.
 */
export function isTaskRetryError(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const code: unknown = Reflect.get(output, "code");
  return typeof code === "string" && TASK_RETRY_ERROR_CODES.includes(code);
}
