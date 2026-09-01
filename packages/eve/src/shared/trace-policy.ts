import type { ChannelAudience } from "#shared/channel-audience.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import {
  DROP_INSTRUMENTATION,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";

/** @deprecated Use `TraceCapturePolicy` to select directional content. */
export type InstrumentationCapture = "content" | "metadata";

export interface TraceCaptureContext {
  readonly agentName: string;
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

export function legacyCaptureTracePolicy(
  capture: InstrumentationCapture | undefined,
): TraceCapturePolicy | undefined {
  if (capture === undefined) return undefined;
  const recordsContent = capture === "content";
  return () => ({
    emit: true,
    recordInputs: recordsContent,
    recordOutputs: recordsContent,
  });
}

export function resolveTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: TraceCaptureContext,
  onError?: (error: unknown) => void,
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
  } catch (error) {
    try {
      onError?.(error);
    } catch {}
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
