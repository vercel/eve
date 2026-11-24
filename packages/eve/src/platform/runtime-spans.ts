import { installedPlatform } from "#platform/context.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

function agentRunsSpanProcessor(): (() => SpanProcessor) | undefined {
  const platform = installedPlatform();
  return platform === undefined ? vercelRuntimeSpanProcessor : platform.telemetry.spanProcessor;
}

export function exportsAgentRuns(): boolean {
  return agentRunsSpanProcessor() !== undefined;
}

export function runtimeSpanProcessor(): SpanProcessor {
  const spanProcessor = agentRunsSpanProcessor();
  if (spanProcessor === undefined) {
    throw new Error(
      "The installed eve host doesn't export Agent Runs, so it has no Agent Runs span processor. Add `telemetry.spanProcessor` to the platform.",
    );
  }
  return spanProcessor();
}
