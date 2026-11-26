import { setTimeout as sleep } from "node:timers/promises";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  createDevelopmentGenerationArtifactsSource,
  createDevelopmentNitroArtifactsConfig,
} from "#internal/nitro/host/artifacts-config.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { createLogger } from "#internal/logging.js";
import { areSchedulesDisabled } from "#internal/schedules/disabled.js";
import { resolveLocalDevScheduleDatabasePath } from "#internal/schedules/local-dev-provider.js";
import {
  sharedLocalDevScheduleStore,
  type LocalDevScheduleClaim,
} from "#internal/schedules/local-dev-store.js";
import { createLocalDevScheduleDispatcher } from "#internal/schedules/local-dev-dispatch.js";
import { startLocalDevScheduleTimer } from "#internal/schedules/local-dev-timer.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const log = createLogger("schedule.local-dev");

export default function installLocalDevSchedulesRuntimePlugin(nitroApp: {
  readonly hooks: { hook(name: "close", handler: () => void): unknown };
}): void {
  if (areSchedulesDisabled()) return;
  const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  if (!appRoot) {
    throw new Error(
      `eve dev's schedule timer needs the dev worker's app root in ${DEVELOPMENT_WORKER_APP_ROOT_ENV}.`,
    );
  }
  const store = sharedLocalDevScheduleStore(resolveLocalDevScheduleDatabasePath(appRoot));
  let closed = false;

  const loadRuntime = async () => {
    const runtimeAppRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(
      createDevelopmentNitroArtifactsConfig({ appRoot }).devRuntimeArtifactsPointerPath,
    );
    if (runtimeAppRoot === undefined) throw new Error("eve dev has not built the agent yet.");
    const manifest = await loadCompiledManifest({
      compiledArtifactsSource: createDevelopmentGenerationArtifactsSource({
        appRoot,
        runtimeAppRoot,
      }),
    });
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: resolveNitroCompiledArtifactsSource(
        createDevelopmentNitroArtifactsConfig({
          appRoot,
          configuredWorld: manifest.config.experimental?.workflow?.world,
        }),
      ),
    });
    return { manifest, bundle };
  };

  const deliver = async ({ row, scheduledAtMs }: LocalDevScheduleClaim) => {
    const { manifest, bundle } = await loadRuntime();
    const definition = await loadScheduleCollectionDefinition(bundle, row.collection, {
      manifest,
    });
    await dispatchScheduledOccurrence({
      bundle,
      runtime: createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
      collection: row.collection,
      definition,
      occurrence: occurrenceOf(row, scheduledAtMs),
      payload: parseSchedulePayload(row.payload, {
        application: manifest.config.name,
        collection: row.collection,
      }),
      namespace: row.namespace,
    });
  };

  const reportFailure = async ({ row, scheduledAtMs }: LocalDevScheduleClaim, reason: string) => {
    try {
      const { manifest, bundle } = await loadRuntime();
      const definition = await loadScheduleCollectionDefinition(bundle, row.collection, {
        manifest,
      });
      const occurrence = occurrenceOf(row, scheduledAtMs);
      await definition.events?.["occurrence.failed"]?.({
        collection: row.collection,
        executionId: occurrence.executionId,
        name: occurrence.name,
        occurrence,
        reason,
        scheduledAt: occurrence.scheduledAt,
        scheduleId: occurrence.scheduleId,
        type: "occurrence.failed",
      });
    } catch (error) {
      log.warn(
        `Local schedule "${row.name}" could not report its failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const dispatch = createLocalDevScheduleDispatcher({
    deliver,
    fail: async (claim, reason, attempts) => {
      log.warn(`Local schedule "${claim.row.name}" failed after ${attempts} attempt(s): ${reason}`);
      await reportFailure(claim, reason);
    },
    isClosed: () => closed,
    sleep,
  });
  const timer = startLocalDevScheduleTimer({ store, dispatch });
  nitroApp.hooks.hook("close", () => {
    closed = true;
    timer.stop();
    store.close();
  });
}

function occurrenceOf(row: LocalDevScheduleClaim["row"], scheduledAtMs: number) {
  return {
    collection: row.collection,
    executionId: `${row.scheduleId}:${scheduledAtMs}`,
    name: row.name,
    scheduleId: row.scheduleId,
    scheduledAt: new Date(scheduledAtMs).toISOString(),
  };
}
