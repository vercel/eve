import type { Entities } from "#platform/entities.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

function agentRunsSpanProcessor(platform: Entities | undefined): (() => SpanProcessor) | undefined {
  return platform === undefined ? vercelRuntimeSpanProcessor : platform.telemetry.spanProcessor;
}

export function exportsAgentRuns(platform: Entities | undefined): boolean {
  return agentRunsSpanProcessor(platform) !== undefined;
}

export function runtimeSpanProcessor(platform: Entities | undefined): SpanProcessor {
  const spanProcessor = agentRunsSpanProcessor(platform);
  if (spanProcessor === undefined) {
    throw new Error(
      "The installed eve host doesn't export Agent Runs, so it has no Agent Runs span processor. Add `telemetry.spanProcessor` to the platform.",
    );
  }
  return spanProcessor();
}
