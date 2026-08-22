import { TraceFlags, type SpanContext } from "#compiled/@opentelemetry/api/index.js";

export function isSampledTrace(context: Pick<SpanContext, "traceFlags">): boolean {
  return (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
}
