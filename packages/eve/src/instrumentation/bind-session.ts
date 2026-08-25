import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import { contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
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
import { recordErrorOnSpan } from "#internal/logging.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";

interface InstrumentationTurnTraceState {
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

const InstrumentationTurnTraceKey = new ContextKey<InstrumentationTurnTraceState>(
  "eve.instrumentation.turnTrace",
);

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
  const providerHooks = frozenHooks(input.runtime?.hooks, plan?.captureLevel === "content");
  const hooks: InstrumentationHooks = {
    capturesContent: providerHooks.capturesContent,
    publish: (event) => providerHooks.publish(enrichEvent(event, plan)),
  };
  const runInContext = input.runtime?.runInContext ?? ((_operation, execute) => execute());
  const usesOtel = input.runtime?.otelSettings !== undefined;

  return {
    capturesContent: hooks.capturesContent,
    forceFlush: input.runtime?.forceFlush ?? (async () => undefined),
    hooks,
    preparePreamble: async (preamble) => {
      const traceContext =
        preamble.traceContext ?? contextStorage.getStore()?.get(InstrumentationTurnTraceKey);
      let prepared = traceContext;
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
      return traceContext ?? prepared;
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
    publish: async (event) => hooks.publish(event),
    runInContext,
    runStep: async (step, execute) => {
      if (!usesOtel) return execute();
      const tracer = trace.getTracer("eve");
      const turnSpan = step.hasInput
        ? tracer.startSpan("ai.eve.turn", {
            attributes: {
              "ai.telemetry.functionId":
                input.runtime?.otelSettings?.functionId ?? step.agentName ?? "",
              "eve.environment": step.environment,
              "eve.session.id": step.sessionId,
              "eve.turn.id": step.turnId,
              "eve.version": step.eveVersion,
            },
          })
        : undefined;
      const store = contextStorage.getStore();
      if (turnSpan !== undefined) {
        store?.set(InstrumentationTurnTraceKey, turnSpan.spanContext());
      }
      const stored = store?.get(InstrumentationTurnTraceKey);
      const parentContext =
        turnSpan !== undefined
          ? trace.setSpan(otelContext.active(), turnSpan)
          : stored === undefined
            ? undefined
            : trace.setSpan(
                otelContext.active(),
                trace.wrapSpanContext({ ...stored, isRemote: true }),
              );
      try {
        return parentContext === undefined
          ? await execute()
          : await otelContext.with(parentContext, execute);
      } catch (error) {
        if (turnSpan !== undefined) recordErrorOnSpan(turnSpan, error);
        throw error;
      } finally {
        turnSpan?.end();
      }
    },
    runtimeContextResolvers: input.runtime?.runtimeContextResolvers,
    runtimeContextChannel: {
      kind: normalizeInstrumentationChannelKind(plan?.channelKind),
      metadata: plan?.channelMetadata ?? {},
    },
    telemetryForAttempt: (attempt) => {
      if (!usesOtel && attempt.bridgeIntegration === undefined) return undefined;
      const includeRuntimeContext: Record<string, true> = {};
      for (const key of Object.keys(attempt.runtimeContext ?? {})) {
        includeRuntimeContext[key] = true;
      }
      return {
        functionId: input.runtime?.otelSettings?.functionId ?? attempt.agentName,
        includeRuntimeContext,
        integrations:
          attempt.bridgeIntegration === undefined
            ? undefined
            : [attempt.bridgeIntegration, ...(attempt.registeredIntegrations ?? [])],
        isEnabled: true,
        recordInputs: plan?.sampled === true || plan?.recordInputs === true,
        recordOutputs: plan?.sampled === true || plan?.recordOutputs === true,
      };
    },
    usesOtel,
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
  if (event.type === "turn.started") {
    return {
      ...event,
      parentLineage: plan.parentLineage,
      parentTraceContext: plan.parentTraceContext,
      rootSessionId: plan.rootSessionId || event.rootSessionId,
    };
  }
  if ("scope" in event) {
    return {
      ...event,
      scope: {
        ...event.scope,
        channelAudience: plan.audience,
        functionId: plan.functionId ?? event.scope.functionId,
        rootSessionId: plan.rootSessionId || event.scope.rootSessionId,
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
