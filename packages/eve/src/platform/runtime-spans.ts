import type { Entities } from "#platform/entities.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export function exportsAgentRuns(platform: Entities): boolean {
  return platform.telemetry.spanProcessor !== undefined;
}

export function runtimeSpanProcessor(platform: Entities): SpanProcessor {
  const { spanProcessor } = platform.telemetry;
  if (spanProcessor === undefined) {
    throw new Error(
      "The installed eve host doesn't export Agent Runs, so it has no Agent Runs span processor. Add `telemetry.spanProcessor` to the platform.",
    );
  }
  return spanProcessor();
}
