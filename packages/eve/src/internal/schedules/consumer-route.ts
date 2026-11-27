import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { isVercelSchedulesDevEnvironment } from "#internal/schedules/dev-environment.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

export const EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH = "/.well-known/eve/v1/schedules/consumer";

export const EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES = 10;

export function createEveScheduleQueueTrigger(agentName: string) {
  return {
    type: "queue/v2beta" as const,
    topic: deriveEveScheduleQueueTopic(agentName),
    retryAfterSeconds: 5,
    initialDelaySeconds: 0,
    maxDeliveries: EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES,
  };
}

export function usesLocalVercelSchedules(
  manifest: Pick<CompiledAgentManifest, "scheduleCollections">,
): boolean {
  return isVercelSchedulesDevEnvironment() && hasVercelScheduleCollections(manifest);
}

export function hasVercelScheduleCollections(manifest: {
  readonly scheduleCollections?: readonly { readonly providerKind: string }[];
}): boolean {
  return (
    manifest.scheduleCollections?.some((collection) => collection.providerKind === "vercel") ??
    false
  );
}

export function hasLocalDevScheduleCollections(manifest: {
  readonly scheduleCollections?: readonly { readonly providerKind: string }[];
}): boolean {
  return (
    manifest.scheduleCollections?.some((collection) => collection.providerKind === "local-dev") ??
    false
  );
}
