import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import type { Clearance } from "#harness/clearance.js";
import type { JsonObject } from "#shared/json.js";

const TASK_PROMOTION = Symbol.for("eve.tools.taskPromotion");
const TASK_PROMOTION_ALLOWED = Symbol.for("eve.tools.taskPromotionAllowed");

export interface TaskPromotion {
  readonly [TASK_PROMOTION]: true;
  readonly handoff: JsonObject;
  readonly onCancel?: () => Promise<void> | void;
  readonly preview?: string;
  readonly workflowId: string;
}

export interface PromotedTaskCall {
  readonly callId: string;
  readonly clearance: Clearance;
  readonly handoff: JsonObject;
  readonly input: unknown;
  readonly onCancel?: () => Promise<void> | void;
  readonly preview?: string;
  readonly toolName: string;
  readonly workflowId: string;
}

export function promoteToTask<TOutput = TaskPromotion>(input: {
  readonly handoff: JsonObject;
  readonly onCancel?: () => Promise<void> | void;
  readonly preview?: string;
  readonly workflowId: string;
}): TOutput {
  const promotion: TaskPromotion = {
    [TASK_PROMOTION]: true,
    handoff: input.handoff,
    ...(input.onCancel !== undefined && { onCancel: input.onCancel }),
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
  return contextScopeValue<boolean>(TASK_PROMOTION_ALLOWED) === true;
}

export function withTaskPromotionAllowed<T>(allowed: boolean, fn: () => T): T {
  return withContextScopeValue(TASK_PROMOTION_ALLOWED, allowed, fn);
}

export async function cancelPromotedTasks(tasks: readonly PromotedTaskCall[]): Promise<void> {
  await Promise.allSettled(tasks.map((task) => task.onCancel?.()));
}
