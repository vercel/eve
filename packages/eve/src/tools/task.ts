import type { JsonObject } from "#shared/json.js";

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
