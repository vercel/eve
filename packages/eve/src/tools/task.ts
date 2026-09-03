import type { JsonObject } from "#shared/json.js";

const TASK_SET_STATE_KIND = "eve:task-set-state" as const;
const TASK_MESSAGE_KIND = "eve:task-message" as const;

export type TaskSetState = JsonObject & {
  readonly kind: typeof TASK_SET_STATE_KIND;
  readonly state: JsonObject;
};

export type TaskMessage = JsonObject & {
  readonly kind: typeof TASK_MESSAGE_KIND;
  readonly message: string;
};

export function createTaskSetState(state: JsonObject): TaskSetState {
  return { kind: TASK_SET_STATE_KIND, state };
}

export function createTaskMessage(message: string): TaskMessage {
  if (message.trim() === "") throw new TypeError("Task messages must not be empty.");
  return { kind: TASK_MESSAGE_KIND, message };
}

export function isTaskSetState(value: unknown): value is TaskSetState {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === TASK_SET_STATE_KIND
  );
}

export function isTaskMessage(value: unknown): value is TaskMessage {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === TASK_MESSAGE_KIND
  );
}

/** Opaque, framework-private address used to control a task executor. */
export interface TaskExecutorBinding {
  readonly kind: string;
  readonly data: JsonObject;
}

/** Fixed acknowledgement returned when a background task is admitted. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}

/** Capability passed only to tools declared with `execution: "background"`. */
export interface TaskExec {
  /** Model-facing durable task identity. */
  readonly taskId: string;
  /** Returns a descriptor which replaces the task's durable model-visible state when yielded. */
  setState(state: JsonObject): TaskSetState;
  /** Returns a descriptor which sends one message to the parent when yielded. */
  postMessage(message: string): TaskMessage;
}
