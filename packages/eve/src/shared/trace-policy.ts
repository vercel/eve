import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import type { ConversationContext } from "#shared/conversation-context.js";

export function isSampledTrace(context: { readonly traceFlags: number }): boolean {
  return (context.traceFlags & 1) !== 0;
}
import {
  DROP_INSTRUMENTATION,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";

/**
 * What a {@link TraceCapturePolicy} receives: the agent name and the conversation's channel,
 * audience, environment, and principal type.
 */
export type TraceCaptureContext = { readonly agentName: string } & ConversationContext;

/** Whether to emit a trace and, when emitting, whether to record model inputs and outputs. */
export type TracePolicyDecision =
  | { readonly emit: false }
  | {
      readonly emit: true;
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

/**
 * Decides per conversation whether to emit traces and record content. `true` emits and records
 * content only for public audiences or in development; `false` drops the trace.
 */
export type TraceCapturePolicy = (trace: TraceCaptureContext) => TracePolicyDecision | boolean;

export function resolveTracePolicy(
  policy: TraceCapturePolicy | undefined,
  trace: TraceCaptureContext,
  onError?: (error: unknown) => void,
): InstrumentationDecision {
  try {
    const decision = policy?.(trace);
    return resolveTracePolicyDecision(decision ?? true, trace);
  } catch (error) {
    try {
      onError?.(error);
    } catch {}
    return DROP_INSTRUMENTATION;
  }
}

export function resolveTracePolicyDecision(
  decision: TracePolicyDecision | boolean,
  context: {
    readonly audience: TraceCaptureContext["audience"];
    readonly environment: TraceCaptureContext["environment"];
  },
): InstrumentationDecision {
  if (decision === false) return DROP_INSTRUMENTATION;
  if (decision === true) {
    const content = shouldCaptureInstrumentationContent(context);
    return { action: "record", recordInputs: content, recordOutputs: content };
  }
  if (!decision.emit) return DROP_INSTRUMENTATION;
  return {
    action: "record",
    recordInputs: decision.recordInputs,
    recordOutputs: decision.recordOutputs,
    ...(decision.recordInputs || decision.recordOutputs
      ? { explicitContentAudience: context.audience }
      : undefined),
  };
}
