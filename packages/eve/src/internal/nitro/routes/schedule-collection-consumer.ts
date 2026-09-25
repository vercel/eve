import { handleCallback } from "@vercel/queue";
import { SchedulesApiError, SchedulesClient } from "@vercel/schedules";

import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

import { ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import {
  expectScheduleQueueMessage,
  PermanentScheduleMessageError,
  verifyScheduleDelivery,
} from "#internal/schedules/verify-delivery.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/** Handles one private Vercel Queues callback for dynamic schedule collections. */
export async function handleScheduleCollectionConsumer(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  const handler = handleCallback<unknown>(
    async (message, metadata) => {
      const payload = expectScheduleQueueMessage(message);
      const application = payload.payload.eve.application;
      const collectionName = payload.payload.eve.collection;
      const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
      const [bundle, manifest] = await Promise.all([
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
        loadCompiledManifest({ compiledArtifactsSource }),
      ]);
      if (manifest.config.name !== application) {
        throw new PermanentScheduleMessageError("Schedule application does not match this agent.");
      }
      const compiled = manifest.scheduleCollections.find(
        (candidate) => candidate.name === collectionName && candidate.providerKind === "vercel",
      );
      if (compiled === undefined) {
        throw new PermanentScheduleMessageError(
          "Schedule collection is not deployed by this agent.",
        );
      }
      if (
        !payload.namespace.startsWith("eve-") ||
        metadata.topicName !== deriveEveScheduleQueueTopic(application)
      ) {
        throw new PermanentScheduleMessageError("Schedule delivery does not match this agent.");
      }
      const schedules = new SchedulesClient();
      let schedule;
      try {
        schedule = await schedules.get({ name: payload.name, namespace: payload.namespace });
      } catch (error) {
        if (error instanceof SchedulesApiError && error.status === 404) {
          throw new PermanentScheduleMessageError("Schedule delivery does not match this agent.");
        }
        throw error;
      }
      verifyScheduleDelivery(payload, schedule, application, metadata.topicName);
      const value = await loadResolvedModuleExport({
        definition: compiled,
        kindLabel: "schedule collection",
        moduleMap: bundle.moduleMap,
        nodeId: undefined,
      });
      const definition = normalizeScheduleCollectionDefinition(
        value,
        `Expected schedule collection "${collectionName}" to match the public eve shape.`,
      );
      const validation = await definition.payloadSchema["~standard"].validate(
        payload.payload.payload,
      );
      if (validation.issues !== undefined) {
        throw new PermanentScheduleMessageError("Scheduled collection input is invalid.");
      }
      const executionId = payload.executionId ?? metadata.messageId;
      const scheduledAt =
        payload.scheduledAt ?? payload.firedAt ?? metadata.createdAt.toISOString();
      const dispatcher = new ScheduleDispatcher({
        runtime: createWorkflowRuntime({ compiledArtifactsSource }),
        channels: bundle.graph.root.channels,
      });
      const result = await dispatcher.triggerCollection({
        collectionId: collectionName,
        payload: validation.value,
        occurrence: {
          executionId,
          name: payload.name,
          scheduleId: payload.scheduleId,
          scheduledAt,
        },
        run: definition.run,
      });
      await Promise.all(result.waitUntilTasks);
    },
    {
      retry(error) {
        return error instanceof PermanentScheduleMessageError
          ? { acknowledge: true as const }
          : undefined;
      },
    },
  );
  return await handler(request);
}
