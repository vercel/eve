import { ROOT_CONTEXT, type SpanContext, type Tracer } from "#compiled/@opentelemetry/api/index.js";

import {
  sessionIdempotencyKey,
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import { evaluateTracePolicy, isSampledTrace } from "#tracing/sampled-trace.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { withNativeSamplingDecision } from "#tracing/native-sampling.js";

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
  ) => Promise<InstrumentationTraceContext>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
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
        input.tracer.startSpan(
          "agent.session",
          {
            attributes: {
              "agent.framework.name": "eve",
              "agent.framework.version": input.frameworkVersion,
              "agent.channel.audience": session.channelAudience,
              "agent.name": session.agentName,
              "agent.session.id": session.sessionId,
              "agent.trace.schema.version": 2,
            },
            root: true,
          },
          withNativeSamplingDecision(ROOT_CONTEXT, true),
        );
      const span = input.idGenerator.withSpanId(session.traceSeed.spanId, () =>
        input.idGenerator.withTraceId(session.traceSeed!.traceId, startSpan),
      );
      span.addEvent("session.started");
      span.end();
      return span.spanContext();
    }
    // Fallback for already-running workflows that predate the seed.
    if (
      !evaluateTracePolicy(input.tracePolicy, {
        agentName: session.agentName,
        audience: session.channelAudience,
        channelType: session.channelType,
      })
    ) {
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
      state = {
        agentName: event.agentName,
        channelAudience: normalizeChannelAudience(event.channelAudience),
        channelKind: event.channelKind,
        context:
          event.parentTraceContext === undefined
            ? openSessionTrace({
                agentName: event.agentName,
                channelAudience: normalizeChannelAudience(event.channelAudience),
                channelType: event.channelType,
                rootSessionId: event.rootSessionId,
                sessionId: event.sessionId,
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
  ): Promise<InstrumentationTraceContext> => {
    return portableSpanContext((await ensureSessionContext(event)).context);
  };

  const prepareTurnTrace = async (
    event: InstrumentationTurnStartedEvent,
  ): Promise<InstrumentationTraceContext> => {
    const prepared = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (prepared !== undefined) {
      return {
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
    return portableSpanContext(session.context);
  };

  return { ensureSessionContext, prepareSessionTrace, prepareTurnTrace };
}

function portableSpanContext(spanContext: SpanContext): InstrumentationTraceContext {
  return {
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
