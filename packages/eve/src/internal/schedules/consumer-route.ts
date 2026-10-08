import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

export const EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH = "/.well-known/eve/v1/schedules/consumer";

/** Deliveries the queue attempts before giving up on an occurrence. */
export const EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES = 10;

/** The queue trigger that delivers an agent's scheduled occurrences to its consumer. */
export function createEveScheduleQueueTrigger(agentName: string) {
  return {
    type: "queue/v2beta" as const,
    topic: deriveEveScheduleQueueTopic(agentName),
    retryAfterSeconds: 5,
    initialDelaySeconds: 0,
    maxDeliveries: EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES,
  };
}

/** Whether a build needs the Vercel schedule consumer: its route and its queue trigger. */
export function hasVercelScheduleCollections(manifest: {
  readonly scheduleCollections?: readonly { readonly providerKind: string }[];
}): boolean {
  return (
    manifest.scheduleCollections?.some((collection) => collection.providerKind === "vercel") ??
    false
  );
}
