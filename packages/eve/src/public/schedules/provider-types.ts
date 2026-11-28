import type { ScheduleOccurrence, ScheduleScopeValue } from "#public/schedules/subscription.js";

/**
 * An occurrence a schedule provider hands back to eve to run, with the schedule's stored payload.
 */
export interface ScheduleDelivery<TPayload = unknown> {
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrence;
}

/**
 * Where a schedule's occurrences go: a stable `key` identifying the application, and a
 * `deliver` function a provider can call to run an occurrence in process.
 */
export interface ScheduleDeliveryTarget {
  readonly key: string;
  readonly deliver?: (delivery: ScheduleDelivery<any>) => Promise<void>;
}

/**
 * What each schedule provider operation receives. Partition storage by `collection` and
 * `namespace`, and treat `operationId` as an idempotency key, since eve may retry an operation.
 */
export interface ScheduleProviderContext {
  readonly abortSignal: AbortSignal;
  readonly collection: string;
  readonly namespace: string;
  readonly operationId: string;
  /** The authorized scope that `namespace` is derived from. */
  readonly scope: ScheduleScopeValue;
  readonly target: ScheduleDeliveryTarget;
}
