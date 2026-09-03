import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationChannelDeliveryStartedEvent,
  InstrumentationChannelDeliveryTerminalEvent,
  InstrumentationHandlerContext,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { sessionIdempotencyKey, turnIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";

interface ChannelDeliverySpanState {
  readonly channelAudience: ChannelAudience;
  readonly inputAttribute?: string;
  readonly parent?: SpanContext;
  readonly requestTraceContext?: SpanContext;
  readonly spanId: string;
  readonly startTimeMs: number;
  readonly traceContext: SpanContext;
  readonly turnId?: string;
}

/** Builds durable channel delivery spans around the turn that consumes each request. */
export function createAgentChannelDeliveryInstrumentation(input: {
  readonly ensureSessionContext: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<AgentSessionTraceState>;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly recordInputs: boolean;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  | "channel.delivery.cancelled"
  | "channel.delivery.completed"
  | "channel.delivery.failed"
  | "channel.delivery.started"
> {
  const onStarted = async (
    event: InstrumentationChannelDeliveryStartedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> => {
    const startTimeMs = Date.now();
    const session = await input.ensureSessionContext({
      agentName: event.agentName,
      channelAudience: event.delivery.channelAudience,
      channelKind: event.delivery.channelKind,
      idempotencyKey: sessionIdempotencyKey(event.sessionId),
      parentTraceContext: event.parentTraceContext,
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
      traceSeed: event.traceSeed,
      type: "session.started",
    });
    let turn =
      event.turnId === undefined || event.sequence === undefined
        ? undefined
        : await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (turn === undefined && event.turnId !== undefined && event.sequence !== undefined) {
      await input.prepareTurnTrace({
        agentName: event.agentName,
        idempotencyKey: turnIdempotencyKey(event.sessionId, event.turnId),
        parentLineage: session.parentLineage,
        parentTraceContext: event.parentTraceContext,
        rootSessionId: event.rootSessionId,
        sequence: event.sequence,
        sessionId: event.sessionId,
        turnId: event.turnId,
        type: "turn.started",
      });
      turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
    }
    const traceContext = turn?.context ?? session.context;
    if (!isSampledTrace(traceContext)) return;
    const inputAttribute = input.recordInputs ? contentAttribute(event.input, false) : undefined;
    const state: Record<string, JsonValue> = {
      channelAudience: normalizeChannelAudience(event.delivery.channelAudience),
      spanId: input.idGenerator.deriveSpanId(`channel-delivery:${event.idempotencyKey}`),
      startTimeMs,
      traceContext: {
        isRemote: traceContext.isRemote ?? false,
        spanId: traceContext.spanId,
        traceFlags: traceContext.traceFlags,
        traceId: traceContext.traceId,
      },
    };
    if (turn?.parentSpanId !== undefined) {
      state.parent = {
        isRemote: turn.parentIsRemote ?? false,
        spanId: turn.parentSpanId,
        traceFlags: turn.context.traceFlags,
        traceId: turn.context.traceId,
      };
    } else if (turn === undefined && event.parentTraceContext !== undefined) {
      const parent = adoptedSpanContext(event.parentTraceContext);
      if (parent !== undefined) {
        state.parent = {
          isRemote: parent.isRemote ?? false,
          spanId: parent.spanId,
          traceFlags: parent.traceFlags,
          traceId: parent.traceId,
        };
      }
    }
    if (event.turnId !== undefined) state.turnId = event.turnId;
    if (inputAttribute !== undefined) state.inputAttribute = inputAttribute;
    if (event.delivery.requestTraceContext !== undefined) {
      state.requestTraceContext = {
        spanId: event.delivery.requestTraceContext.spanId,
        traceFlags: event.delivery.requestTraceContext.traceFlags,
        traceId: event.delivery.requestTraceContext.traceId,
      };
    }
    ctx.state.set(state);
  };

  const onTerminal = async (
    event: InstrumentationChannelDeliveryTerminalEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> => {
    const state = readState(ctx.state.get());
    if (state === undefined) return;
    const turn =
      event.turnId === undefined
        ? undefined
        : await input.stateStore.getTurn(event.sessionId, event.turnId);
    const requestLink = state.requestTraceContext;
    const startSpan = () =>
      input.tracer.startSpan(
        "agent.channel.delivery",
        {
          attributes: {
            "agent.channel.delivery.id": event.delivery.deliveryId,
            "agent.channel.delivery.outcome": event.outcome,
            "agent.channel.kind": event.delivery.channelKind,
            "agent.channel.name": event.delivery.channelName,
            "agent.channel.request.id": event.delivery.requestId,
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.name": event.agentName,
            "agent.turn.id": event.turnId,
            "agent.turn.sequence": event.sequence,
            ...agentSpanNamingAttributes("agent.channel.delivery"),
            ...agentTraceIdentityAttributes({
              rootSessionId: event.rootSessionId,
              sessionId: event.sessionId,
            }),
          },
          kind: SpanKind.CONSUMER,
          links:
            requestLink === undefined
              ? undefined
              : [
                  {
                    attributes: { "eve.link.type": "channel.request" },
                    context: requestLink,
                  },
                ],
          root: state.parent === undefined,
          startTime: state.startTimeMs,
        },
        withChannelAudience(
          state.parent === undefined ? ROOT_CONTEXT : contextFromSpanContext(state.parent),
          state.channelAudience,
        ),
      );
    const span = input.idGenerator.withSpanId(state.spanId, () =>
      state.parent === undefined
        ? input.idGenerator.withTraceId(state.traceContext.traceId, startSpan)
        : startSpan(),
    );
    span.addEvent("channel.delivery.started", undefined, state.startTimeMs);
    span.addEvent(event.type);
    if (state.inputAttribute !== undefined) {
      span.setAttribute("agent.channel.delivery.input", state.inputAttribute);
    }
    if (event.outcome === "failed") {
      const errorType =
        event.errorCode ?? (event.error instanceof Error ? event.error.name : "Error");
      span.setAttribute("error.type", errorType);
      if (event.errorCode !== undefined) {
        span.setAttribute("agent.channel.delivery.error.code", event.errorCode);
      }
      recordError(span, event.error);
    }
    span.end();
    if (
      turn !== undefined &&
      event.turnId !== undefined &&
      turn.context.traceId === state.traceContext.traceId &&
      turn.parentSpanId === state.parent?.spanId
    ) {
      await input.stateStore.updateTurn(event.sessionId, event.turnId, (current) =>
        current.context.traceId === state.traceContext.traceId &&
        current.parentSpanId === state.parent?.spanId
          ? { ...current, parentIsRemote: false, parentSpanId: state.spanId }
          : current,
      );
    } else if (event.turnId === undefined && state.turnId !== undefined) {
      await input.stateStore.deleteTurn(event.sessionId, state.turnId);
    }
  };

  return {
    "channel.delivery.cancelled": onTerminal,
    "channel.delivery.completed": onTerminal,
    "channel.delivery.failed": onTerminal,
    "channel.delivery.started": onStarted,
  };
}

function readState(value: unknown): ChannelDeliverySpanState | undefined {
  if (!isRecord(value) || !isSpanContext(value.traceContext)) return undefined;
  if (typeof value.spanId !== "string" || typeof value.startTimeMs !== "number") {
    return undefined;
  }
  const parent = isSpanContext(value.parent) ? value.parent : undefined;
  const requestTraceContext = isSpanContext(value.requestTraceContext)
    ? value.requestTraceContext
    : undefined;
  return {
    channelAudience: normalizeChannelAudience(value.channelAudience),
    inputAttribute: typeof value.inputAttribute === "string" ? value.inputAttribute : undefined,
    parent,
    requestTraceContext,
    spanId: value.spanId,
    startTimeMs: value.startTimeMs,
    traceContext: value.traceContext,
    turnId: typeof value.turnId === "string" ? value.turnId : undefined,
  };
}

function adoptedSpanContext(
  context: InstrumentationChannelDeliveryStartedEvent["parentTraceContext"],
): SpanContext | undefined {
  return context === undefined
    ? undefined
    : {
        isRemote: "isRemote" in context && context.isRemote === true,
        spanId: context.spanId,
        traceFlags: context.traceFlags,
        traceId: context.traceId,
      };
}

function isSpanContext(value: unknown): value is SpanContext {
  return (
    isRecord(value) &&
    typeof value.spanId === "string" &&
    typeof value.traceFlags === "number" &&
    typeof value.traceId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextFromSpanContext(spanContext: SpanContext) {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
