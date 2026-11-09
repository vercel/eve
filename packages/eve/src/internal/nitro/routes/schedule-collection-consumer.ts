import {
  handleCallback,
  type MessageHandler,
  type RetryHandler,
} from "#compiled/@vercel/queue/index.js";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { createScheduleOccurrenceConsumer } from "#internal/schedules/occurrence-consumer.js";
import { usesWorldHost, worldHostRuntime } from "#internal/nitro/routes/world-host.js";

/** Receives verified Vercel Schedules occurrences and dispatches at-least-once callbacks. */
export async function handleScheduleCollectionConsumer(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  const { handler, retry } = createScheduleCollectionConsumer(config);
  return await handleCallback(handler, { retry })(request);
}

/** Shares occurrence verification and dispatch between hosted callbacks and local queue polling. */
export function createScheduleCollectionConsumer(config: NitroArtifactsConfig): {
  readonly handler: MessageHandler<unknown>;
  readonly retry: RetryHandler;
} {
  return createScheduleOccurrenceConsumer({
    compiledArtifactsSource: () => resolveNitroCompiledArtifactsSource(config),
    runtime: (compiledArtifactsSource) =>
      usesWorldHost(config)
        ? worldHostRuntime(config)
        : createWorkflowRuntime({ compiledArtifactsSource }),
  });
}
