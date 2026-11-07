import { type MessageHandler, type RetryHandler } from "#compiled/@vercel/queue/index.js";
import { SchedulesApiError, SchedulesClient } from "#compiled/@vercel/schedules/index.js";

import type { Runtime } from "#channel/types.js";
import { EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES } from "#internal/schedules/consumer-route.js";
import {
  expectScheduleQueueMessage,
  PermanentScheduleMessageError,
  verifyScheduleDelivery,
  type VerifiedScheduleMessage,
} from "#internal/schedules/verify-delivery.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleOccurrenceIdentity,
} from "#public/schedules/subscription.js";
import {
  readVercelScheduleClientOptions,
  VERCEL_SCHEDULES_CLIENT_HEADERS,
} from "#public/schedules/providers/vercel.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import {
  loadScheduleCollectionDefinition,
  ScheduleCollectionNotDeployedError,
} from "#runtime/schedules/load-collection.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * The consumer of a Vercel Schedules collection's occurrences for one agent: each verified
 * occurrence runs the collection's callback, whose sessions start in `runtime`'s, a deployment's
 * Workflow or a World host's.
 */
export function createScheduleOccurrenceConsumer(input: {
  readonly compiledArtifactsSource: () => RuntimeCompiledArtifactsSource;
  readonly runtime: (
    compiledArtifactsSource: RuntimeCompiledArtifactsSource,
  ) => Runtime | Promise<Runtime>;
}): {
  readonly handler: MessageHandler<unknown>;
  readonly retry: RetryHandler;
} {
  return {
    handler: async (message, metadata) => {
      const queue = expectScheduleQueueMessage(message);
      const application = queue.payload.eve.application;
      const collection = queue.payload.eve.collection;
      const source = input.compiledArtifactsSource();
      const [bundle, manifest] = await Promise.all([
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
        loadCompiledManifest({ compiledArtifactsSource: source }),
      ]);
      if (manifest.config.name !== application)
        throw new PermanentScheduleMessageError("Schedule application does not match this agent.");
      if (
        !queue.namespace.startsWith("eve-") ||
        metadata.topicName !== deriveEveScheduleQueueTopic(application)
      )
        throw new PermanentScheduleMessageError("Schedule delivery does not match this agent.");
      let definition: DynamicSchedulesDefinition<unknown>;
      try {
        definition = await loadScheduleCollectionDefinition(bundle, collection, {
          manifest,
          providerKind: "vercel",
        });
      } catch (error) {
        if (error instanceof ScheduleCollectionNotDeployedError)
          throw new PermanentScheduleMessageError(error.message);
        throw error;
      }
      const occurrence: ScheduleOccurrenceIdentity = {
        collection,
        executionId: queue.executionId ?? metadata.messageId,
        name: queue.name,
        scheduleId: queue.scheduleId,
        scheduledAt: queue.scheduledAt ?? queue.firedAt ?? metadata.createdAt.toISOString(),
      };
      try {
        let payload;
        try {
          payload = parseSchedulePayload<unknown>(queue.payload.payload, {
            application,
            collection,
          });
        } catch {
          throw new PermanentScheduleMessageError("Scheduled collection request is invalid.");
        }
        await dispatchScheduledOccurrence({
          bundle,
          collection,
          definition,
          occurrence,
          payload,
          runtime: await input.runtime(bundle.compiledArtifactsSource),
          verifyDelivery: async () =>
            verifyScheduleDelivery(
              queue,
              await getSchedule(definition, queue),
              application,
              metadata.topicName,
            ),
        });
      } catch (error) {
        // Report failure only when the provider stops retrying this callback.
        const final =
          error instanceof PermanentScheduleMessageError ||
          metadata.deliveryCount >= EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES;
        if (final) {
          await definition.events?.["occurrence.failed"]?.({
            collection,
            executionId: occurrence.executionId,
            name: occurrence.name,
            occurrence,
            reason: error instanceof Error ? error.message : "Scheduled occurrence failed.",
            scheduledAt: occurrence.scheduledAt,
            scheduleId: occurrence.scheduleId,
            type: "occurrence.failed",
          });
        }
        throw error;
      }
    },
    retry(error) {
      return error instanceof PermanentScheduleMessageError
        ? { acknowledge: true as const }
        : undefined;
    },
  };
}

/** Reads the delivered schedule with the collection provider's own client options. */
async function getSchedule(
  definition: DynamicSchedulesDefinition<unknown>,
  queue: VerifiedScheduleMessage,
) {
  try {
    return await new SchedulesClient({
      ...readVercelScheduleClientOptions(definition.provider),
      headers: VERCEL_SCHEDULES_CLIENT_HEADERS,
    }).get({ name: queue.name, namespace: queue.namespace });
  } catch (error) {
    if (error instanceof SchedulesApiError && error.status === 404)
      throw new PermanentScheduleMessageError("Schedule delivery does not match this agent.");
    throw error;
  }
}
