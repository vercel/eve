import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import type { HarnessSession } from "#harness/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const TASK_MESSAGE_KIND = "eve:task-message" as const;

export type TaskMessage = JsonObject & {
  readonly kind: typeof TASK_MESSAGE_KIND;
  readonly message: string;
};

export function createTaskMessage(message: string): TaskMessage {
  if (message.trim() === "") throw new TypeError("Task messages must not be empty.");
  return { kind: TASK_MESSAGE_KIND, message };
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

/** @deprecated Use workflow-backed background tools with yield descriptors. */
export interface TaskBinding {
  readonly taskId: string;
  readonly token: string;
  readonly url?: string;
}

/** @deprecated Use workflow-backed background tools with yield descriptors. */
export type TaskSendCommand =
  | { readonly kind: "update"; readonly message: string }
  | { readonly kind: "complete"; readonly data: JsonValue }
  | { readonly kind: "fail"; readonly data: JsonValue }
  | { readonly kind: "cancel" };

/** Fixed acknowledgement returned when a background task is admitted. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}

/** Capability passed only to tools declared with `execution: "background"`. */
export interface TaskExec {
  /** Model-facing durable task identity. */
  readonly taskId: string;
  /** Returns a descriptor which sends one message to the parent when yielded. */
  postMessage(message: string): TaskMessage;
  /** @deprecated Use yields from a workflow-backed background tool. */
  readonly binding: TaskBinding;
  /** @deprecated Use yields from a workflow-backed background tool. */
  readonly send: (command: TaskSendCommand) => Promise<void>;
  /** @deprecated Use ctx.session. */
  readonly session: HarnessSession;
  /** @deprecated Framework-owned task internals are not part of the authoring API. */
  readonly task: BackgroundTask;
}
