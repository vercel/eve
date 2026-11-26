import { contextStorage } from "#context/container.js";
import { TaskPromotionAllowedKey } from "#context/keys.js";
import type { Clearance } from "#harness/clearance.js";
import type { JsonObject } from "#shared/json.js";

const TASK_PROMOTION = Symbol.for("eve.tools.taskPromotion");

export interface TaskPromotion {
  readonly [TASK_PROMOTION]: true;
  readonly handoff: JsonObject;
  readonly preview?: string;
  readonly workflowId: string;
}

export interface PromotedTaskCall {
  readonly callId: string;
  readonly clearance: Clearance;
  readonly handoff: JsonObject;
  readonly input: unknown;
  readonly preview?: string;
  readonly toolName: string;
  readonly workflowId: string;
}

export function promoteToTask<TOutput = TaskPromotion>(input: {
  readonly handoff: JsonObject;
  readonly preview?: string;
  readonly workflowId: string;
}): TOutput {
  const promotion: TaskPromotion = {
    [TASK_PROMOTION]: true,
    handoff: input.handoff,
    ...(input.preview !== undefined && { preview: input.preview }),
    workflowId: input.workflowId,
  };
  return promotion as never;
}

export function isTaskPromotion(value: unknown): value is TaskPromotion {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, TASK_PROMOTION) === true &&
    typeof Reflect.get(value, "workflowId") === "string"
  );
}

export function canPromoteToTask(): boolean {
  return contextStorage.getStore()?.get(TaskPromotionAllowedKey) === true;
}
