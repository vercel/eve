import type { SpanContext, Tracer } from "#compiled/@opentelemetry/api/index.js";

import {
  sessionIdempotencyKey,
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTurnStartedEvent,
} from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import {
  SESSION_WINDOW_TURN_LIMIT,
  type AgentSessionTraceState,
  type AgentTraceStateStore,
} from "#tracing/agent-trace-state.js";

interface AgentOtelSessionContextInput {
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
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
  const openSessionWindow = (window: {
    readonly agentName?: string;
    readonly index: number;
    readonly parentTraceContext?: InstrumentationTraceContext;
    readonly previousTraceId?: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
  }): SpanContext => {
    const parent =
      window.parentTraceContext === undefined
        ? undefined
        : adoptedSpanContext(window.parentTraceContext);
    // A session owns its durable trace; handed context records causality without
    // merging the session into a request, parent agent, or remote deployment trace.
    const span = input.tracer.startSpan("agent.session", {
      attributes: {
        "agent.framework.name": "eve",
        "agent.framework.version": input.frameworkVersion,
        "agent.name": window.agentName,
        "agent.root.session.id": window.rootSessionId,
        "agent.session.id": window.sessionId,
        "agent.session.window": window.index,
        "agent.trace.schema.version": 1,
        ...(window.previousTraceId === undefined
          ? {}
          : { "agent.session.window.previous.trace.id": window.previousTraceId }),
      },
      links:
        parent === undefined
          ? undefined
          : [{ attributes: { "eve.link.type": "session.parent" }, context: parent }],
      root: true,
    });
    span.addEvent(window.index === 0 ? "session.started" : "session.window.opened");
    // The window outlives this worker and has no guaranteed close — an idle
    // session never ends — so the window is recorded as a zero-duration marker
    // and later spans parent through its persisted context.
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
        channelKind: event.channelKind,
        context: openSessionWindow({
          agentName: event.agentName,
          index: 0,
          parentTraceContext: event.parentTraceContext,
          rootSessionId: event.rootSessionId,
          sessionId: event.sessionId,
        }),
        rootSessionId: event.rootSessionId,
        turnsInWindow: 0,
        window: 0,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const advanceSessionWindow = (
    sessionId: string,
    session: AgentSessionTraceState,
  ): AgentSessionTraceState => {
    if (session.turnsInWindow < SESSION_WINDOW_TURN_LIMIT) return session;
    const index = session.window + 1;
    return {
      ...session,
      context: openSessionWindow({
        agentName: session.agentName,
        index,
        previousTraceId: session.context.traceId,
        rootSessionId: session.rootSessionId,
        sessionId,
      }),
      turnsInWindow: 0,
      window: index,
    };
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

    const session = advanceSessionWindow(
      event.sessionId,
      await ensureSessionContext({
        agentName: undefined,
        channelKind: undefined,
        idempotencyKey: sessionIdempotencyKey(event.sessionId),
        parentTraceContext: event.parentTraceContext,
        rootSessionId: event.rootSessionId,
        sessionId: event.sessionId,
        type: "session.started",
      }),
    );
    // The turn outlives this worker, so no live span can cover it: the span
    // id is allocated now for descendants to parent through, and the span
    // itself is emitted at the turn's session transition.
    const turnContext: SpanContext = {
      isRemote: false,
      spanId: input.idGenerator.deriveSpanId(`turn:${event.idempotencyKey}`),
      traceFlags: session.context.traceFlags,
      traceId: session.context.traceId,
    };
    await input.stateStore.setSession(event.sessionId, {
      ...session,
      turnsInWindow: session.turnsInWindow + 1,
    });
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      context: turnContext,
      lineage: event.parentLineage,
      parentIsRemote: session.context.isRemote,
      parentSpanId: session.context.spanId,
      rootSessionId: event.rootSessionId,
      sequence: event.sequence,
      startTimeMs: Date.now(),
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
