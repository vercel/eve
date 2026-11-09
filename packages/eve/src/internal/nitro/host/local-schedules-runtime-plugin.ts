import { PollingQueueClient } from "#compiled/@vercel/queue/index.js";

import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  createDevelopmentGenerationArtifactsSource,
  createDevelopmentNitroArtifactsConfig,
} from "#internal/nitro/host/artifacts-config.js";
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
  let snapshot:
    | {
        readonly root: string;
        readonly consumer: ReturnType<typeof createScheduleCollectionConsumer>;
        readonly trigger: ReturnType<typeof createEveScheduleQueueTrigger> | undefined;
      }
    | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFailure: string | undefined;

  // Service-hosted queue functions are not discovered by vc dev yet.
  const poll = async () => {
    let delay = 1_000;
    try {
      const root = readDevelopmentRuntimeArtifactsSnapshotRoot(
        config.devRuntimeArtifactsPointerPath,
      );
      if (root === undefined) return;
      if (snapshot?.root !== root) {
        const manifest = await loadCompiledManifest({
          compiledArtifactsSource: createDevelopmentGenerationArtifactsSource({
            appRoot,
            runtimeAppRoot: root,
          }),
        });
        snapshot = {
          root,
          consumer: createScheduleCollectionConsumer(
            createDevelopmentNitroArtifactsConfig({
              appRoot,
              configuredWorld: manifest.config.experimental?.workflow?.world,
            }),
          ),
          trigger: hasVercelScheduleCollections(manifest)
            ? createEveScheduleQueueTrigger(manifest.config.name)
            : undefined,
        };
      }
      if (!closed && snapshot.trigger !== undefined) {
        const {
          consumer,
          trigger: { topic, maxDeliveries, retryAfterSeconds },
        } = snapshot;
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
      lastFailure = undefined;
    } catch (error) {
      if (closed) return;
      let reason = error instanceof Error ? error.message : "Unknown local schedule error";
      for (const secret of [token, process.env.VERCEL_SCHEDULE_TOKEN]) {
        if (secret) reason = reason.replaceAll(secret, "[redacted]");
      }
      reason = reason.slice(0, 1_000);
      if (reason !== lastFailure) {
        console.warn(
          `[eve] Local schedule delivery failed: ${reason}. Check vc dev's local Queues and Schedules APIs; retrying in 5s.`,
        );
        lastFailure = reason;
      }
      delay = 5_000;
    } finally {
      if (!closed) {
        timer = setTimeout(() => void poll(), delay);
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
