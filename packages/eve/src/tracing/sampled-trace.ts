import { TraceFlags, type SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";

export function isSampledTrace(context: Pick<SpanContext, "traceFlags">): boolean {
  return (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
}

export function evaluateTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: {
    readonly agentName?: string;
    readonly audience: ChannelAudience;
    readonly channelType?: string;
  },
): boolean {
  try {
    return (
      policy?.({
        agentName: trace.agentName,
        audience: trace.audience,
        channelType: trace.channelType,
      }) ?? trace.audience === "public"
    );
  } catch {
    return false;
  }
}
