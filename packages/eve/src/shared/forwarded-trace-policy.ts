import type { ChannelAudience } from "#shared/channel-audience.js";
import { applyAudienceCeiling } from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  DROP_INSTRUMENTATION,
  intersectInstrumentationDecisions,
  readInstrumentationDecision,
} from "#shared/instrumentation-decision.js";

const FAIL_CLOSED_TRACE_ASSERTION: ForwardedTraceAssertion = {
  ceiling: { recordInputs: false, recordOutputs: false },
  originAudience: "unknown",
};

export interface TraceContentCeiling {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

export interface ForwardedTraceAssertion {
  readonly ceiling: TraceContentCeiling;
  readonly originAudience: ChannelAudience;
}

export interface ResolvedForwardedTraceState {
  readonly decision?: InstrumentationDecision;
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly traceFlags: number;
}

export interface ForwardedTraceSeedState {
  readonly decision?: unknown;
  readonly forwardedTracePolicy?: unknown;
  readonly traceFlags: number;
}

export function decisionToTraceContentCeiling(value: unknown): TraceContentCeiling | undefined {
  const decision = readInstrumentationDecision(value);
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

/** Applies a distinct live delivery audience without re-capping callback or origin delivery. */
export function applyLiveDeliveryAudienceCeiling(
  decision: InstrumentationDecision,
  liveAudience: ChannelAudience,
  forwardedTracePolicy: ForwardedTraceAssertion | undefined,
): InstrumentationDecision {
  return forwardedTracePolicy !== undefined &&
    (liveAudience === "unknown" || liveAudience === forwardedTracePolicy.originAudience)
    ? decision
    : applyAudienceCeiling(decision, liveAudience);
}

export function readForwardedTraceAssertion(value: unknown): ForwardedTraceAssertion | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return FAIL_CLOSED_TRACE_ASSERTION;
  }
  const candidate = value as Partial<ForwardedTraceAssertion>;
  const ceiling = candidate.ceiling;
  if (
    ceiling === null ||
    typeof ceiling !== "object" ||
    typeof ceiling.recordInputs !== "boolean" ||
    typeof ceiling.recordOutputs !== "boolean"
  ) {
    return FAIL_CLOSED_TRACE_ASSERTION;
  }
  if (
    candidate.originAudience !== "public" &&
    candidate.originAudience !== "private" &&
    candidate.originAudience !== "unknown"
  ) {
    return FAIL_CLOSED_TRACE_ASSERTION;
  }
  return {
    ceiling: {
      recordInputs: ceiling.recordInputs,
      recordOutputs: ceiling.recordOutputs,
    },
    originAudience: candidate.originAudience,
  };
}

/** Resolves the coupled durable decision and assertion without allowing either to widen the other. */
function resolveForwardedTraceState(input: {
  readonly decision: unknown;
  readonly forwardedTracePolicy: unknown;
  readonly traceFlags: number;
}): ResolvedForwardedTraceState {
  const forwardedTracePolicy = readForwardedTraceAssertion(input.forwardedTracePolicy);
  let decision = readInstrumentationDecision(input.decision);
  if (forwardedTracePolicy !== undefined) {
    const ceiling = traceContentCeilingToDecision(forwardedTracePolicy.ceiling);
    decision =
      decision === undefined
        ? DROP_INSTRUMENTATION
        : intersectInstrumentationDecisions(decision, ceiling);
  }
  return {
    decision,
    forwardedTracePolicy,
    traceFlags: decision?.action === "drop" ? input.traceFlags & ~1 : input.traceFlags,
  };
}

export function resolveForwardedTraceSeed(
  seed: ForwardedTraceSeedState | undefined,
  fallbackPolicy?: ForwardedTraceAssertion,
): ResolvedForwardedTraceState | undefined {
  if (seed === undefined) return undefined;
  const hasPolicy = Object.prototype.hasOwnProperty.call(seed, "forwardedTracePolicy");
  return resolveForwardedTraceState({
    decision: seed.decision,
    forwardedTracePolicy: hasPolicy ? seed.forwardedTracePolicy : fallbackPolicy,
    traceFlags: seed.traceFlags,
  });
}
