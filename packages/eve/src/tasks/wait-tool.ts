import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";
import type { TaskOutcome } from "#tasks/protocol.js";

// The model's tool for waiting on one detached task. The harness reads this
// module, so it must stay free of Node.js built-ins.

/**
 * Marks the model tool that waits on a detached task. Its calls defer like
 * a workflow tool's, and the owner applies them to its task table; nothing
 * with this ID is ever started as a workflow.
 */
export const TASK_WAIT_WORKFLOW_ID = "eve//task-wait";

/** Longest `timeout`: the largest delay a durable timer can schedule, about 24.8 days. */
export const MAX_TASK_WAIT_TIMEOUT_MS = 2_147_483_647;

/** Structured output of one `task_wait` call, for clients. */
export type TaskWaitOutput =
  | {
      readonly status: "settled";
      readonly taskId: string;
      /** The tool that started the task, whose `toModelOutput` shapes the result. */
      readonly name: string;
      readonly outcome: TaskOutcome;
    }
  | { readonly status: "timed_out" | "interrupted" | "idle"; readonly taskId: string };

export function isTaskWaitTool(tool: { readonly workflowId?: string } | undefined): boolean {
  return tool?.workflowId === TASK_WAIT_WORKFLOW_ID;
}

export function isTaskWaitRequest(
  request: Pick<RuntimeWorkflowTaskRequest, "workflowId">,
): boolean {
  return request.workflowId === TASK_WAIT_WORKFLOW_ID;
}

/** One `task_wait` call's input. */
export interface TaskWaitInput {
  readonly taskId: string;
  /** Absent waits until a result or a message arrives; `0` returns at once. */
  readonly timeoutMs?: number;
}

/**
 * Reads one call's input: a non-empty, bounded task ID and an optional
 * timeout from 0 to {@link MAX_TASK_WAIT_TIMEOUT_MS} milliseconds. Returns
 * `undefined` for anything else.
 */
export function readTaskWaitInput(input: JsonObject): TaskWaitInput | undefined {
  const { taskId, timeout } = input;
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH) {
    return undefined;
  }
  if (timeout === undefined || timeout === null) return { taskId };
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    timeout > MAX_TASK_WAIT_TIMEOUT_MS
  ) {
    return undefined;
  }
  return { taskId, timeoutMs: Math.floor(timeout) };
}

/** Reads the output of a `task_wait` call that received its task's result. */
export function readSettledTaskWaitOutput(
  output: JsonValue,
): Extract<TaskWaitOutput, { readonly status: "settled" }> | undefined {
  if (!isJsonObjectValue(output)) return undefined;
  const { name, status, taskId } = output;
  const outcome = readTaskOutcome(output.outcome);
  if (status !== "settled" || typeof taskId !== "string" || typeof name !== "string") {
    return undefined;
  }
  return outcome === undefined ? undefined : { name, outcome, status, taskId };
}

function readTaskOutcome(value: JsonValue | undefined): TaskOutcome | undefined {
  if (!isJsonObjectValue(value)) return undefined;
  switch (value.status) {
    case "completed":
      return value.output === undefined ? undefined : { output: value.output, status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
    case "failed": {
      const { error } = value;
      if (
        !isJsonObjectValue(error) ||
        typeof error.code !== "string" ||
        typeof error.message !== "string"
      ) {
        return undefined;
      }
      return { error: { code: error.code, message: error.message }, status: "failed" };
    }
    default:
      return undefined;
  }
}
