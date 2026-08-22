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
} from "#harness/instrumentation/lifecycle.js";
import { sessionIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";

interface ChannelDeliverySpanState {
  readonly channelAudience: ChannelAudience;
  readonly inputAttribute?: string;
  readonly parent: SpanContext;
  readonly requestTraceContext?: SpanContext;
  readonly spanId: string;
  readonly startTimeMs: number;
  readonly window: number;
}

/** Builds durable channel delivery spans around the turn that consumes each request. */
export function createAgentChannelDeliveryInstrumentation(input: {
  readonly ensureSessionContext: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<AgentSessionTraceState>;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
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
    const session = await input.ensureSessionContext({
      agentName: event.agentName,
      channelAudience: event.delivery.channelAudience,
      channelKind: event.delivery.channelKind,
      idempotencyKey: sessionIdempotencyKey(event.sessionId),
      parentTraceContext: event.parentTraceContext,
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
      type: "session.started",
    });
    if (!isSampledTrace(session.context)) return;
    const inputAttribute = input.recordInputs ? contentAttribute(event.input, false) : undefined;
    const state: Record<string, JsonValue> = {
      channelAudience: normalizeChannelAudience(event.delivery.channelAudience),
      parent: {
        isRemote: session.context.isRemote ?? false,
        spanId: session.context.spanId,
        traceFlags: session.context.traceFlags,
        traceId: session.context.traceId,
      },
      spanId: input.idGenerator.deriveSpanId(`channel-delivery:${event.idempotencyKey}`),
      startTimeMs: Date.now(),
      window: session.window,
    };
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
    const session = await input.stateStore.getSession(event.sessionId);
    const parent =
      turn === undefined
        ? state.parent
        : {
            isRemote: turn.parentIsRemote ?? false,
            spanId: turn.parentSpanId,
            traceFlags: turn.context.traceFlags,
            traceId: turn.context.traceId,
          };
    const startTimeMs =
      turn === undefined ? state.startTimeMs : Math.max(state.startTimeMs, turn.startTimeMs);
    const requestLink = state.requestTraceContext;
    const span = input.idGenerator.withSpanId(state.spanId, () =>
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
            "agent.root.session.id": event.rootSessionId,
            "agent.session.id": event.sessionId,
            "agent.session.window": session?.window ?? state.window,
            "agent.turn.id": event.turnId,
            "agent.turn.sequence": event.sequence,
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
          startTime: startTimeMs,
        },
        contextFromSpanContext(parent),
      ),
    );
    span.addEvent("channel.delivery.started", undefined, startTimeMs);
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
  };

  return {
    "channel.delivery.cancelled": onTerminal,
    "channel.delivery.completed": onTerminal,
    "channel.delivery.failed": onTerminal,
    "channel.delivery.started": onStarted,
  };
}

function readState(value: unknown): ChannelDeliverySpanState | undefined {
  if (!isRecord(value) || !isSpanContext(value.parent)) return undefined;
  if (
    typeof value.spanId !== "string" ||
    typeof value.startTimeMs !== "number" ||
    typeof value.window !== "number"
  ) {
    return undefined;
  }
  const requestTraceContext = isSpanContext(value.requestTraceContext)
    ? value.requestTraceContext
    : undefined;
  return {
    channelAudience: normalizeChannelAudience(value.channelAudience),
    inputAttribute: typeof value.inputAttribute === "string" ? value.inputAttribute : undefined,
    parent: value.parent,
    requestTraceContext,
    spanId: value.spanId,
    startTimeMs: value.startTimeMs,
    window: value.window,
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
