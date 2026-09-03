import type { SessionTraceContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  intersectInstrumentationDecisions,
  readInstrumentationDecision,
} from "#shared/instrumentation-decision.js";
import {
  type ForwardedTraceAssertion,
  traceContentCeilingToDecision,
} from "#shared/forwarded-trace-policy.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";

export function resolveInitialSessionTraceSeed(input: {
  readonly agentName: string;
  readonly audience: ReturnType<typeof normalizeChannelAudience>;
  readonly channelType?: string;
  readonly forwardedTracePolicy: ForwardedTraceAssertion | undefined;
  readonly parentTraceContext?: SessionTraceContext;
  readonly runtime: InstrumentationRuntime | undefined;
  readonly seed?: SessionTraceSeed;
}): SessionTraceSeed | undefined {
  return input.seed === undefined
    ? allocateSessionTraceSeed(input)
    : evaluatePreallocatedSessionTraceSeed({ ...input, seed: input.seed });
}

function evaluatePreallocatedSessionTraceSeed(
  input: Parameters<typeof resolveInitialSessionTraceSeed>[0] & {
    readonly seed: SessionTraceSeed;
  },
): SessionTraceSeed {
  const localDecision = resolveTracePolicy(input.runtime?.otelSettings?.tracePolicy, {
    agentName: input.agentName,
    audience: input.audience,
    channelType: input.channelType,
  });
  const decision =
    input.forwardedTracePolicy === undefined
      ? localDecision
      : intersectInstrumentationDecisions(
          localDecision,
          traceContentCeilingToDecision(input.forwardedTracePolicy.ceiling),
        );
  const sampled =
    decision.action === "record" && (input.runtime?.samplesTrace?.(input.seed.traceId) ?? true);
  return {
    decision,
    forwardedTracePolicy: input.forwardedTracePolicy,
    spanId: input.seed.spanId,
    traceFlags: sampled ? input.seed.traceFlags | 1 : input.seed.traceFlags & ~1,
    traceId: input.seed.traceId,
  };
}

function allocateSessionTraceSeed(
  input: Parameters<typeof resolveInitialSessionTraceSeed>[0],
): SessionTraceSeed | undefined {
  if (input.parentTraceContext !== undefined) {
    const forwardedCeiling = input.forwardedTracePolicy
      ? traceContentCeilingToDecision(input.forwardedTracePolicy.ceiling)
      : undefined;
    const inheritedDecision = readInstrumentationDecision(input.parentTraceContext.decision);
    const parentDecision = forwardedCeiling
      ? inheritedDecision === undefined
        ? forwardedCeiling
        : intersectInstrumentationDecisions(forwardedCeiling, inheritedDecision)
      : (inheritedDecision ??
        resolveTracePolicyDecision(isSampledTrace(input.parentTraceContext), input.audience));
    const decision = input.forwardedTracePolicy
      ? intersectInstrumentationDecisions(
          parentDecision,
          resolveTracePolicy(input.runtime?.otelSettings?.tracePolicy, {
            agentName: input.agentName,
            audience: input.audience,
            channelType: input.channelType,
          }),
        )
      : parentDecision;
    return {
      decision,
      forwardedTracePolicy: input.forwardedTracePolicy,
      spanId: input.parentTraceContext.spanId,
      traceFlags:
        input.forwardedTracePolicy !== undefined && decision.action === "drop"
          ? input.parentTraceContext.traceFlags & ~1
          : input.parentTraceContext.traceFlags,
      traceId: input.parentTraceContext.traceId,
    };
  }
  if (input.runtime?.prepareSessionTrace === undefined || input.runtime.idGenerator === undefined) {
    return undefined;
  }
  const decision = resolveTracePolicy(input.runtime.otelSettings?.tracePolicy, {
    agentName: input.agentName,
    audience: input.audience,
    channelType: input.channelType,
  });
  const traceId = input.runtime.idGenerator.generateTraceId();
  const sampled = decision.action === "record" && (input.runtime.samplesTrace?.(traceId) ?? true);
  return {
    decision,
    spanId: input.runtime.idGenerator.allocateSpanId(),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}
