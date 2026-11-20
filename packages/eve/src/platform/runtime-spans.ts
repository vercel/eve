import { platformContext, type PlatformTarget } from "#platform/context.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";

const IMPLEMENTATIONS: Record<PlatformTarget, () => SpanProcessor> = {
  vercel: vercelRuntimeSpanProcessor,
};

export function runtimeSpanProcessor(): SpanProcessor {
  return IMPLEMENTATIONS[platformContext().target]();
}
