import type { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ModeKey,
  OtelTraceEnabledKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
  type SessionTraceSeed,
} from "#context/keys.js";
import type { SessionTraceContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import {
  ConversationContextKey,
  resolveConversationContext,
  type ConversationContext,
} from "#shared/conversation-context.js";
import {
  formatTraceContentCeiling,
  readForwardedTraceAssertion,
  type ForwardedTraceAssertion,
  traceContentCeilingToDecision,
} from "#shared/forwarded-trace-policy.js";
import {
  intersectInstrumentationDecisions,
  readInstrumentationDecision,
} from "#shared/instrumentation-decision.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";

const log = createLogger("instrumentation.session-init");

export function initializeSessionInstrumentation(input: {
  readonly agentName: string;
  readonly ctx: ContextContainer;
}): void {
  const runtime = getInstrumentationRuntime();
  const parentTraceContext = input.ctx.get(ParentTraceContextKey);
  const forwardedTracePolicy = readForwardedTraceAssertion(
    parentTraceContext?.forwardedTracePolicy,
  );
  const storedConversation = input.ctx.get(ConversationContextKey);
  const conversation = resolveConversationContext(
    storedConversation,
    {
      channelKind: input.ctx.get(ChannelInstrumentationKey)?.kind,
      environment: resolveInstrumentationEnvironment(),
      forwardedTracePolicy,
      mode: input.ctx.get(ModeKey),
      principalType: input.ctx.get(AuthKey)?.principalType,
    },
    { forwardedOverridesStored: true },
  );
  const traceSeed = allocateSessionTraceSeed({
    agentName: input.agentName,
    conversation,
    channelType: input.ctx.get(ChannelInstrumentationKey)?.channelType,
    forwardedTracePolicy,
    parentTraceContext,
    runtime,
  });
  if (traceSeed !== undefined) {
    input.ctx.set(SessionTraceSeedKey, traceSeed);
    if (forwardedTracePolicy !== undefined) {
      log.info("resolved forwarded trace policy", {
        ceilingEffective:
          traceSeed.decision?.action === "record"
            ? formatTraceContentCeiling(traceSeed.decision)
            : "drop",
        ceilingIn: formatTraceContentCeiling(forwardedTracePolicy.ceiling),
        originAudience: forwardedTracePolicy.originAudience,
      });
    }
    if (forwardedTracePolicy !== undefined && parentTraceContext !== undefined) {
      const resolvedParent = {
        ...parentTraceContext,
        decision: traceSeed.decision,
        traceFlags: traceSeed.traceFlags,
      };
      delete resolvedParent.forwardedTracePolicy;
      input.ctx.set(ParentTraceContextKey, resolvedParent);
    }
  }
  input.ctx.set(OtelTraceEnabledKey, false);
}

function allocateSessionTraceSeed(input: {
  readonly agentName: string;
  readonly conversation: ConversationContext;
  readonly channelType?: string;
  readonly forwardedTracePolicy: ForwardedTraceAssertion | undefined;
  readonly parentTraceContext?: SessionTraceContext;
  readonly runtime: InstrumentationRuntime | undefined;
}): SessionTraceSeed | undefined {
  const localDecision = () =>
    resolveTracePolicy(input.runtime?.otelSettings?.tracePolicy, {
      agentName: input.agentName,
      ...input.conversation,
    });
  if (input.parentTraceContext !== undefined) {
    const forwardedCeiling = input.forwardedTracePolicy
      ? traceContentCeilingToDecision(input.forwardedTracePolicy.ceiling)
      : undefined;
    const inheritedDecision = readInstrumentationDecision(input.parentTraceContext.decision);
    const parentDecision = !isSampledTrace(input.parentTraceContext)
      ? { action: "drop" as const }
      : forwardedCeiling
        ? inheritedDecision === undefined
          ? forwardedCeiling
          : intersectInstrumentationDecisions(forwardedCeiling, inheritedDecision)
        : (inheritedDecision ??
          resolveTracePolicyDecision(isSampledTrace(input.parentTraceContext), input.conversation));
    const decision = input.forwardedTracePolicy
      ? intersectInstrumentationDecisions(parentDecision, localDecision())
      : parentDecision;
    const idGenerator = input.runtime?.idGenerator ?? new AgentSpanIdGenerator();
    return {
      decision,
      ...(input.forwardedTracePolicy === undefined
        ? undefined
        : { forwardedTracePolicy: input.forwardedTracePolicy }),
      spanId: idGenerator.allocateSpanId(),
      traceFlags: decision.action === "drop" ? 0 : input.parentTraceContext.traceFlags,
      traceId: idGenerator.generateTraceId(),
    };
  }
  if (input.runtime?.prepareSessionTrace === undefined || input.runtime.idGenerator === undefined)
    return undefined;
  const decision = localDecision();
  const traceId = input.runtime.idGenerator.generateTraceId();
  const sampled = decision.action === "record";
  return {
    decision,
    spanId: input.runtime.idGenerator.allocateSpanId(),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}
