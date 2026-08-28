import type { ChannelAudience } from "#shared/channel-audience.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import {
  DROP_INSTRUMENTATION,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";

export interface TraceCaptureContext {
  readonly agentName?: string;
  readonly audience: ChannelAudience;
  readonly channelType?: string;
}

export type TracePolicyDecision =
  | { readonly emit: false }
  | {
      readonly emit: true;
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export type TraceCapturePolicy = (trace: TraceCaptureContext) => TracePolicyDecision | boolean;

export function resolveTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: TraceCaptureContext,
): InstrumentationDecision {
  try {
    const decision = policy?.({
      agentName: trace.agentName,
      audience: trace.audience,
      channelType: trace.channelType,
    });
    return resolveTracePolicyDecision(
      decision ?? {
        emit: true,
        recordInputs: trace.audience === "public",
        recordOutputs: trace.audience === "public",
      },
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
