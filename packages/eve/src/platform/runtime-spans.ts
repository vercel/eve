import { platformContext } from "#platform/context.js";
import { hostService } from "#platform/services.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export function runtimeSpanProcessor(): SpanProcessor {
  const agentRuns = hostService(platformContext(), "agentRuns", () => ({
    spanProcessor: vercelRuntimeSpanProcessor,
  }));
  if (agentRuns === undefined) {
    throw new Error(
      "The installed eve host doesn't export Agent Runs, so it has no Agent Runs span processor. Add agentRuns to the host's services.",
    );
  }
  return agentRuns.spanProcessor();
}
