import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

export interface TraceContentCeiling {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

export interface ForwardedTraceAssertion {
  readonly ceiling: TraceContentCeiling;
  readonly originAudience: ChannelAudience;
}

export interface AcceptedForwardedTracePolicy extends ForwardedTraceAssertion {
  readonly forwarder: string;
}

export function decisionToTraceContentCeiling(
  decision: InstrumentationDecision | undefined,
): TraceContentCeiling | undefined {
  return decision?.action === "record"
    ? {
        recordInputs: decision.recordInputs,
        recordOutputs: decision.recordOutputs,
      }
    : undefined;
}

export function traceContentCeilingToDecision(
  ceiling: TraceContentCeiling,
): InstrumentationDecision {
  return { action: "record", ...ceiling };
}

export function formatTraceContentCeiling(ceiling: TraceContentCeiling): string {
  return `i${ceiling.recordInputs ? "1" : "0"}o${ceiling.recordOutputs ? "1" : "0"}`;
}

export function readAcceptedForwardedTracePolicy(
  value: unknown,
): AcceptedForwardedTracePolicy | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<AcceptedForwardedTracePolicy>;
  const ceiling = candidate.ceiling;
  if (
    ceiling === null ||
    typeof ceiling !== "object" ||
    typeof ceiling.recordInputs !== "boolean" ||
    typeof ceiling.recordOutputs !== "boolean"
  ) {
    return undefined;
  }
  if (
    candidate.originAudience !== "public" &&
    candidate.originAudience !== "private" &&
    candidate.originAudience !== "unknown"
  ) {
    return undefined;
  }
  if (typeof candidate.forwarder !== "string" || candidate.forwarder.length === 0) {
    return undefined;
  }
  return {
    ceiling: {
      recordInputs: ceiling.recordInputs,
      recordOutputs: ceiling.recordOutputs,
    },
    forwarder: candidate.forwarder,
    originAudience: candidate.originAudience,
  };
}
