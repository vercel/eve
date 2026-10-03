import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { withoutInstrumentationContent } from "#instrumentation/content.js";
import { instrumentationEventForTraceDecision } from "#instrumentation/content-policy.js";
import type {
  InstrumentationEvent,
  InstrumentationAttemptScope,
} from "#instrumentation/lifecycle.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { isSampledTrace, resolveTracePolicyDecision } from "#shared/trace-policy.js";
import {
  applyLiveDeliveryAudienceCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";

export function createEveCapturePolicy(input: {
  readonly stateStore: AgentTraceStateStore;
  readonly environment: ConversationEnvironment;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}) {
  return {
    async projectEvent(event: InstrumentationEvent): Promise<InstrumentationEvent> {
      const session = await input.stateStore.get(
        "session",
        "scope" in event ? event.scope.sessionId : event.sessionId,
      );
      const audience = audienceForEvent(event, session?.channelAudience);
      const eventSeed = "traceSeed" in event ? event.traceSeed : undefined;
      const contextSeed = contextStorage.getStore()?.get(SessionTraceSeedKey);
      const contextTraceState = resolveForwardedTraceSeed(contextSeed);
      const eventTraceState = resolveForwardedTraceSeed(
        eventSeed,
        contextTraceState?.forwardedTracePolicy,
      );
      const decisionForTrace = (trace: { readonly traceFlags: number } | undefined) =>
        trace === undefined
          ? undefined
          : resolveTracePolicyDecision(isSampledTrace(trace), {
              audience,
              environment: input.environment,
            });
      const decision =
        eventTraceState?.decision ??
        contextTraceState?.decision ??
        readInstrumentationDecision(session?.decision) ??
        decisionForTrace(eventSeed) ??
        decisionForTrace(contextSeed) ??
        decisionForTrace(session?.context);
      if (decision === undefined) return withoutInstrumentationContent(event);
      const normalizedEvent =
        eventTraceState === undefined || !("traceSeed" in event) || event.traceSeed === undefined
          ? event
          : {
              ...event,
              traceSeed: {
                ...event.traceSeed,
                decision: eventTraceState.decision,
                traceFlags: eventTraceState.traceFlags,
              },
            };
      return instrumentationEventForTraceDecision(
        normalizedEvent,
        applyLiveDeliveryAudienceCeiling(
          decision.action === "drop"
            ? decision
            : {
                action: "record",
                recordInputs: input.recordInputs && decision.recordInputs,
                recordOutputs: input.recordOutputs && decision.recordOutputs,
              },
          audience,
          eventTraceState?.forwardedTracePolicy ?? contextTraceState?.forwardedTracePolicy,
          input.environment,
        ),
        { audience, environment: input.environment },
        { applyAudienceCeiling: false },
      );
    },
    async forOperation(scope: InstrumentationAttemptScope) {
      const session = await input.stateStore.get("session", scope.sessionId);
      const seed = resolveForwardedTraceSeed(contextStorage.getStore()?.get(SessionTraceSeedKey));
      const decision = seed?.decision ?? session?.decision;
      const effective =
        decision === undefined
          ? undefined
          : applyLiveDeliveryAudienceCeiling(
              decision,
              normalizeChannelAudience(scope.channelAudience),
              seed?.forwardedTracePolicy,
              input.environment,
            );
      return {
        recordInputs:
          input.recordInputs && effective?.action === "record" && effective.recordInputs,
        recordOutputs:
          input.recordOutputs && effective?.action === "record" && effective.recordOutputs,
      };
    },
  };
}

function audienceForEvent(
  event: InstrumentationEvent,
  sessionAudience: ChannelAudience | undefined,
): ChannelAudience {
  if ("delivery" in event) return normalizeChannelAudience(event.delivery.channelAudience);
  if ("scope" in event && event.scope.channelAudience !== undefined)
    return normalizeChannelAudience(event.scope.channelAudience);
  if (event.type === "session.started") return normalizeChannelAudience(event.channelAudience);
  return normalizeChannelAudience(sessionAudience);
}
