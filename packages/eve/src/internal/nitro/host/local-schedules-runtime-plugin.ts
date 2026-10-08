import { PollingQueueClient } from "#compiled/@vercel/queue/index.js";

import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { createScheduleCollectionConsumer } from "#internal/nitro/routes/schedule-collection-consumer.js";
import {
  createEveScheduleQueueTrigger,
  hasVercelScheduleCollections,
} from "#internal/schedules/consumer-route.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

export default function installLocalSchedulesRuntimePlugin(nitroApp: {
  readonly hooks: { hook(name: "close", handler: () => void): unknown };
}): void {
  const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  const baseUrl = process.env.VERCEL_QUEUE_BASE_URL;
  const token = process.env.VERCEL_QUEUE_TOKEN;
  if (!appRoot || !baseUrl || !token) {
    throw new Error(
      "Local Vercel Schedules requires eve's dev worker and the local Queues API. Start eve through `vc dev` with a CLI that supports local Schedules and Queues.",
    );
  }
  const endpoint = new URL(baseUrl);
  const queue = new PollingQueueClient({
    deploymentId: null,
    region: "dev1",
    resolveBaseUrl: () => endpoint,
    token,
  });
  const config = createDevelopmentNitroArtifactsConfig({ appRoot });
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Service-hosted queue functions are not discovered by vc dev yet.
  const poll = async () => {
    try {
      if (
        readDevelopmentRuntimeArtifactsSnapshotRoot(config.devRuntimeArtifactsPointerPath) === null
      )
        return;
      const manifest = await loadCompiledManifest({
        compiledArtifactsSource: resolveNitroCompiledArtifactsSource(config),
      });
      if (!closed && hasVercelScheduleCollections(manifest)) {
        const consumer = createScheduleCollectionConsumer(
          createDevelopmentNitroArtifactsConfig({
            appRoot,
            configuredWorld: manifest.config.experimental?.workflow?.world,
          }),
        );
        const { topic, maxDeliveries, retryAfterSeconds } = createEveScheduleQueueTrigger(
          manifest.config.name,
        );
        await queue.receive(
          topic,
          topic,
          async (message, metadata) => {
            if (closed) throw new Error("Local schedule consumer is closing.");
            await consumer.handler(message, metadata);
          },
          {
            retry: (error, metadata) =>
              consumer.retry(error, metadata) ??
              (metadata.deliveryCount >= maxDeliveries
                ? { acknowledge: true }
                : { afterSeconds: retryAfterSeconds }),
          },
        );
      }
    } catch {
      if (!closed) console.warn("[eve] Local schedule delivery failed; it will be retried.");
    } finally {
      if (!closed) {
        timer = setTimeout(() => void poll(), 1_000);
        timer.unref();
      }
    }
  };

  nitroApp.hooks.hook("close", () => {
    closed = true;
    clearTimeout(timer);
  });
  void poll();
}
