import type { SpanContext, Tracer } from "#compiled/@opentelemetry/api/index.js";

import {
  sessionIdempotencyKey,
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTraceSeed,
  type InstrumentationTurnStartedEvent,
} from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";

interface AgentOtelSessionContextInput {
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
  readonly tracePolicy?: TraceCapturePolicy;
}

interface AgentOtelSessionContext {
  readonly ensureSessionContext: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<AgentSessionTraceState>;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
}

export function createAgentOtelSessionContext(
  input: AgentOtelSessionContextInput,
): AgentOtelSessionContext {
  const openSessionTrace = (session: {
    readonly agentName?: string;
    readonly channelAudience: ChannelAudience;
    readonly channelType?: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly traceDecision: ReturnType<typeof resolveTracePolicy>;
    readonly traceSeed?: InstrumentationTraceContext;
  }): SpanContext => {
    if (session.traceSeed !== undefined) {
      if (!isSampledTrace(session.traceSeed)) {
        return {
          isRemote: false,
          spanId: session.traceSeed.spanId,
          traceFlags: 0,
          traceId: session.traceSeed.traceId,
        };
      }
      const startSpan = () =>
        input.tracer.startSpan("agent.session", {
          attributes: {
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.channel.audience": session.channelAudience,
            "agent.name": session.agentName,
            "agent.session.id": session.sessionId,
            "agent.trace.schema.version": 2,
          },
          root: true,
        });
      const span = input.idGenerator.withSpanId(session.traceSeed.spanId, () =>
        input.idGenerator.withTraceId(session.traceSeed!.traceId, startSpan),
      );
      span.addEvent("session.started");
      span.end();
      return span.spanContext();
    }
    // Fallback for already-running workflows that predate the seed.
    if (session.traceDecision.action === "drop") {
      return {
        isRemote: false,
        spanId: input.idGenerator.deriveSpanId(`session:${session.sessionId}`),
        traceFlags: 0,
        traceId: input.idGenerator.generateTraceId(),
      };
    }
    const span = input.tracer.startSpan("agent.session", {
      attributes: {
        "agent.framework.name": "eve",
        "agent.framework.version": input.frameworkVersion,
        "agent.channel.audience": session.channelAudience,
        "agent.name": session.agentName,
        "agent.session.id": session.sessionId,
        "agent.trace.schema.version": 2,
      },
      root: true,
    });
    span.addEvent("session.started");
    span.end();
    return span.spanContext();
  };

  const ensureSessionContext = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      const channelAudience = normalizeChannelAudience(event.channelAudience);
      const decision = resolveSessionTraceDecision(event, channelAudience, input.tracePolicy);
      state = {
        agentName: event.agentName,
        channelAudience,
        channelKind: event.channelKind,
        decision,
        context:
          event.parentTraceContext === undefined
            ? openSessionTrace({
                agentName: event.agentName,
                channelAudience,
                channelType: event.channelType,
                rootSessionId: event.rootSessionId,
                sessionId: event.sessionId,
                traceDecision: decision,
                traceSeed: event.traceSeed,
              })
            : adoptedSpanContext(event.parentTraceContext),
        rootSessionId: event.rootSessionId,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const prepareSessionTrace = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const session = await ensureSessionContext(event);
    return portableSpanContext(session.context, session.decision);
  };

  const prepareTurnTrace = async (
    event: InstrumentationTurnStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const prepared = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (prepared !== undefined) {
      const session = await input.stateStore.getSession(event.sessionId);
      return {
        decision: session?.decision,
        spanId: prepared.parentSpanId,
        traceFlags: prepared.context.traceFlags,
        traceId: prepared.context.traceId,
      };
    }

    const session = await ensureSessionContext({
      agentName: undefined,
      channelAudience: "unknown",
      channelKind: undefined,
      idempotencyKey: sessionIdempotencyKey(event.sessionId),
      parentTraceContext: event.parentTraceContext,
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
      type: "session.started",
    });
    // The turn outlives this worker, so no live span can cover it: the span
    // id is allocated now for descendants to parent through, and the span
    // itself is emitted at the turn's session transition.
    const turnContext: SpanContext = {
      isRemote: false,
      spanId: input.idGenerator.deriveSpanId(`turn:${event.idempotencyKey}`),
      traceFlags: session.context.traceFlags,
      traceId: session.context.traceId,
    };
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      context: turnContext,
      parentIsRemote: session.context.isRemote,
      parentSpanId: session.context.spanId,
      rootSessionId: event.rootSessionId,
      sequence: event.sequence,
      startTimeMs: Date.now(),
      subagentName: event.parentLineage?.subagentName,
    });
    return portableSpanContext(session.context, session.decision);
  };

  return { ensureSessionContext, prepareSessionTrace, prepareTurnTrace };
}

function portableSpanContext(
  spanContext: SpanContext,
  decision?: InstrumentationTraceSeed["decision"],
): InstrumentationTraceSeed {
  return {
    decision,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
  };
}

function adoptedSpanContext(handed: InstrumentationTraceContext): SpanContext {
  return {
    isRemote: "isRemote" in handed && handed.isRemote === true,
    spanId: handed.spanId,
    traceFlags: handed.traceFlags,
    traceId: handed.traceId,
  };
}

function resolveSessionTraceDecision(
  event: InstrumentationSessionStartedEvent,
  audience: ChannelAudience,
  policy: TraceCapturePolicy | undefined,
): ReturnType<typeof resolveTracePolicy> {
  if (event.traceSeed?.decision !== undefined) return event.traceSeed.decision;
  if (event.traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.traceSeed), audience);
  }
  if (event.parentTraceContext !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.parentTraceContext), audience);
  }
  // The tool loop can evaluate the same policy before this first-session
  // preparation path; the persisted decision removes that window on replay.
  return resolveTracePolicy(policy, {
    agentName: event.agentName,
    audience,
    channelType: event.channelType,
  });
}
