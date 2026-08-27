import type { ChannelAudience } from "#shared/channel-audience.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import {
  DROP_INSTRUMENTATION,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";
import type { TraceCapturePolicy, TracePolicyDecision } from "#tracing/otel-declaration.js";

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
    readonly channelType?: string;
  },
): boolean {
  return resolveTracePolicy(policy, trace).action === "record";
}

export function resolveTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: {
    readonly agentName?: string;
    readonly audience: ChannelAudience;
    readonly channelType?: string;
  },
): InstrumentationDecision {
  try {
    return resolveTracePolicyDecision(
      policy?.({
        agentName: trace.agentName,
        audience: trace.audience,
        channelType: trace.channelType,
      }) ?? trace.audience === "public",
      trace.audience,
    );
  } catch {
    return DROP_INSTRUMENTATION;
  }
}

export function resolveTracePolicyDecision(
  decision: TracePolicyDecision | boolean,
  audience: ChannelAudience,
): InstrumentationDecision {
  if (decision === false) return DROP_INSTRUMENTATION;
  if (decision === true) {
    const content = shouldCaptureInstrumentationContent(audience);
    return { action: "record", recordInputs: content, recordOutputs: content };
  }
  if (!decision.emit) return DROP_INSTRUMENTATION;
  return {
    action: "record",
    recordInputs: decision.recordInputs,
    recordOutputs: decision.recordOutputs,
  };
}
