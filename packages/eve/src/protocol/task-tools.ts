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

/** A task call the session refused for the model to retry: too many tasks, or an unknown id. */
const TASK_RETRY_ERROR_CODES: readonly string[] = [TOO_MANY_TASKS_CODE, UNKNOWN_TASK_CODE];

/**
 * Whether a tool result is the session refusing a task call for the model
 * to retry. Its message tells the model how to recover, so activity surfaces
 * keep it out of view. Only a failed result counts: an authored tool can
 * return the same `code` as ordinary output.
 */
export function isTaskRetryRefusal(event: FactOf<"call.settled">): boolean {
  if (event.data.outcome !== "failed" && event.data.outcome !== "rejected") return false;
  const code = event.data.error?.code ?? readCode(event.data.output);
  return code !== undefined && TASK_RETRY_ERROR_CODES.includes(code);
}

function readCode(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const code: unknown = Reflect.get(output, "code");
  return typeof code === "string" ? code : undefined;
}
