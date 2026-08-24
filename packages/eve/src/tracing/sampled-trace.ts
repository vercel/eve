import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";

// W3C sampled flag; written as a literal so this module stays out of the
// vendored OTel chunk, which the workflow driver bundle cannot include.
const TRACE_FLAGS_SAMPLED = 0x01;

export function isSampledTrace(context: { readonly traceFlags: number }): boolean {
  return (context.traceFlags & TRACE_FLAGS_SAMPLED) === TRACE_FLAGS_SAMPLED;
}

export function evaluateTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: {
    readonly agentName?: string;
    readonly audience: ChannelAudience;
  },
): boolean {
  try {
    return (
      policy?.({
        agentName: trace.agentName,
        audience: trace.audience,
      }) ?? trace.audience === "public"
    );
  } catch {
    return false;
  }
}
