import { handleCallback } from "@vercel/queue";

import { ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

interface ScheduleQueueMessage {
  readonly executionId?: string;
  readonly firedAt?: string;
  readonly name: string;
  readonly namespace: string;
  readonly payload?: {
    readonly eve?: {
      readonly application?: string;
      readonly collection?: string;
      readonly version?: number;
    };
    readonly input?: unknown;
  };
  readonly scheduleId: string;
  readonly scheduledAt?: string;
  readonly source: string;
}

/** Handles one private Vercel Queues callback for dynamic schedule collections. */
export async function handleScheduleCollectionConsumer(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  const handler = handleCallback<ScheduleQueueMessage>(
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
        (candidate) => candidate.name === collectionName,
      );
      if (compiled === undefined) {
        throw new PermanentScheduleMessageError(
          "Schedule collection is not deployed by this agent.",
        );
      }
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
      const validation = await definition.inputSchema["~standard"].validate(payload.payload.input);
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
        input: validation.value,
        occurrence: {
          executionId,
          name: payload.name,
          scheduleId: payload.scheduleId,
          scheduledAt,
        },
        run: definition.run,
      });
      if (result.waitUntilTasks.length > 0) {
        await Promise.allSettled(result.waitUntilTasks);
      }
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

class PermanentScheduleMessageError extends Error {}

function expectScheduleQueueMessage(value: ScheduleQueueMessage): {
  readonly executionId?: string;
  readonly firedAt?: string;
  readonly name: string;
  readonly namespace: string;
  readonly payload: {
    readonly eve: {
      readonly application: string;
      readonly collection: string;
      readonly version: 1;
    };
    readonly input: unknown;
  };
  readonly scheduleId: string;
  readonly scheduledAt?: string;
  readonly source: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.scheduleId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.namespace !== "string" ||
    typeof value.source !== "string" ||
    typeof value.payload !== "object" ||
    value.payload === null ||
    typeof value.payload.eve !== "object" ||
    value.payload.eve === null ||
    value.payload.eve.version !== 1 ||
    typeof value.payload.eve.application !== "string" ||
    typeof value.payload.eve.collection !== "string"
  ) {
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  }
  return value as ReturnType<typeof expectScheduleQueueMessage>;
}
