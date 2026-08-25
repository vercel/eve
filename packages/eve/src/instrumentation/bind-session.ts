import { withoutInstrumentationContent } from "#instrumentation/content.js";
import {
  sessionIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationEvent,
  type InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import {
  parseSessionInstrumentationPlan,
  readPlanTraceContext,
  type SerializedSessionInstrumentation,
  type SessionInstrumentation,
} from "#instrumentation/session-plan.js";

const inertHooks: InstrumentationHooks = {
  capturesContent: false,
  publish: async () => undefined,
};

export function bindSessionInstrumentation(input: {
  readonly plan: SerializedSessionInstrumentation | undefined;
  readonly rootSessionId: string;
  readonly runtime: InstrumentationRuntime | undefined;
  readonly sessionId: string;
}): SessionInstrumentation {
  if (input.plan !== undefined && input.runtime?.bindSession !== undefined) {
    return input.runtime.bindSession({
      plan: input.plan,
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
    });
  }

  const plan = input.plan === undefined ? undefined : parseSessionInstrumentationPlan(input.plan);
  const hooks = frozenHooks(input.runtime?.hooks, plan?.captureLevel === "content");
  const runInContext = input.runtime?.runInContext ?? ((_operation, execute) => execute());

  return {
    forceFlush: input.runtime?.forceFlush ?? (async () => undefined),
    hooks,
    preparePreamble: async (preamble) => {
      let prepared = preamble.traceContext;
      if (!preamble.sessionStarted && input.runtime?.prepareSessionTrace !== undefined) {
        prepared = await input.runtime.prepareSessionTrace({
          agentName: plan?.agentName,
          channelAudience: plan?.audience,
          channelKind: plan?.channelKind,
          channelType: plan?.channelType,
          idempotencyKey: sessionIdempotencyKey(input.sessionId),
          parentTraceContext: plan?.parentTraceContext,
          rootSessionId: input.rootSessionId,
          sessionId: input.sessionId,
          traceSeed: readPlanTraceContext(input.plan),
          type: "session.started",
        });
      }
      if (input.runtime?.prepareTurnTrace !== undefined) {
        prepared = await input.runtime.prepareTurnTrace({
          idempotencyKey: turnIdempotencyKey(input.sessionId, preamble.turnId),
          parentLineage: plan?.parentLineage,
          parentTraceContext: plan?.parentTraceContext,
          rootSessionId: input.rootSessionId,
          sequence: preamble.sequence,
          sessionId: input.sessionId,
          turnId: preamble.turnId,
          type: "turn.started",
        });
      }
      return preamble.traceContext ?? prepared;
    },
    prepareSessionTrace: input.runtime?.prepareSessionTrace,
    prepareTurnTrace: input.runtime?.prepareTurnTrace,
    propagationFor: ({ callId, sessionId, turnId }) => {
      const traceContext = readPlanTraceContext(input.plan);
      if (traceContext === undefined) return undefined;
      return {
        parentLineage: { callId, sessionId, turnId },
        traceContext,
      };
    },
    publish: async (event) => hooks.publish(enrichEvent(event, plan)),
    runInContext,
    runStep: async (_step, execute) => execute(),
    telemetryForAttempt: () => undefined,
  };
}

function frozenHooks(
  hooks: InstrumentationHooks | undefined,
  capturesContent: boolean,
): InstrumentationHooks {
  if (hooks === undefined) return inertHooks;
  if (capturesContent || !hooks.capturesContent) return hooks;
  return {
    capturesContent: false,
    publish: (event) => hooks.publish(withoutInstrumentationContent(event)),
  };
}

function enrichEvent(
  event: InstrumentationEvent,
  plan: ReturnType<typeof parseSessionInstrumentationPlan>,
): InstrumentationEvent {
  if (plan === undefined) return event;
  if (event.type === "session.started") {
    return {
      ...event,
      agentName: plan.agentName,
      channelAudience: plan.audience,
      channelKind: plan.channelKind,
      channelType: plan.channelType,
      parentTraceContext: plan.parentTraceContext,
      rootSessionId: plan.rootSessionId || event.rootSessionId,
      traceSeed: {
        spanId: plan.spanId,
        traceFlags: plan.traceFlags,
        traceId: plan.traceId,
      },
    };
  }
  if (
    event.type === "channel.delivery.started" ||
    event.type === "channel.delivery.cancelled" ||
    event.type === "channel.delivery.completed" ||
    event.type === "channel.delivery.failed"
  ) {
    return {
      ...event,
      agentName: plan.agentName,
      delivery: { ...event.delivery, channelAudience: plan.audience },
      ...(event.type === "channel.delivery.started"
        ? {
            parentTraceContext: plan.parentTraceContext,
            traceSeed: {
              spanId: plan.spanId,
              traceFlags: plan.traceFlags,
              traceId: plan.traceId,
            },
          }
        : {}),
      rootSessionId: plan.rootSessionId || event.rootSessionId,
    };
  }
  return event;
}
