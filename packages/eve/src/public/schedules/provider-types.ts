import type { ScheduleOccurrence } from "#public/schedules/subscription.js";

export interface ScheduleDelivery<TPayload = unknown> {
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrence;
}

export interface ScheduleDeliveryTarget {
  readonly key: string;
  readonly deliver?: (delivery: ScheduleDelivery<any>) => Promise<void>;
}

export interface ScheduleProviderContext {
  readonly abortSignal: AbortSignal;
  readonly collection: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly target: ScheduleDeliveryTarget;
}
