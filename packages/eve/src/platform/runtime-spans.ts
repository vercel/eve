import { platformHook } from "#platform/capabilities.js";
import { platformContext } from "#platform/context.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export function runtimeSpanProcessor(): SpanProcessor {
  const agentRunsSpanProcessor = platformHook(
    platformContext(),
    "agentRunsSpanProcessor",
    vercelRuntimeSpanProcessor,
  );
  if (agentRunsSpanProcessor === undefined) {
    throw new Error(
      "The installed eve host doesn't support Agent Runs, so it has no Agent Runs span processor. Declare agentRuns in the host's capabilities and add an agentRunsSpanProcessor hook.",
    );
  }
  return agentRunsSpanProcessor();
}
