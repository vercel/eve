import {
  ROOT_CONTEXT,
  SpanKind,
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
} from "#instrumentation/lifecycle.js";
import { contextStorage } from "#context/container.js";
import { ActiveChannelDeliveriesKey } from "#context/keys.js";
import { sessionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";
import { AGENT_SPAN_NAMES } from "#tracing/agent-span-contract.js";
import { recordAgentSpanError as recordError } from "#tracing/agent-span-error.js";

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
    const turn =
      event.turnId === undefined || event.sequence === undefined
        ? undefined
        : await input.stateStore.getTurn(event.sessionId, event.turnId);
    const traceContext = turn?.context ?? {
      ...session.context,
      traceId: input.idGenerator.generateTraceId(),
    };
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
    if (turn !== undefined) {
      state.parent = {
        isRemote: false,
        spanId: turn.context.spanId,
        traceFlags: turn.context.traceFlags,
        traceId: turn.context.traceId,
      };
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
    const traceContext = turn?.context ?? state.traceContext;
    if (!isSampledTrace(traceContext)) return;
    if (
      event.turnId !== undefined &&
      turn !== undefined &&
      isOnlyActiveDelivery(event.sessionId, event.turnId, event.delivery.deliveryId)
    ) {
      await input.stateStore.updateTurn(event.sessionId, event.turnId, (current) => ({
        ...current,
        channelDelivery: {
          channelKind: event.delivery.channelKind,
          channelName: event.delivery.channelName,
          deliveryId: event.delivery.deliveryId,
          ...(state.inputAttribute === undefined
            ? undefined
            : { inputAttribute: state.inputAttribute }),
          ...(event.delivery.requestId === undefined
            ? undefined
            : { requestId: event.delivery.requestId }),
          ...(state.requestTraceContext === undefined
            ? undefined
            : { requestTraceContext: state.requestTraceContext }),
        },
      }));
      return;
    }
    const parent = turn?.context ?? state.parent;
    const requestLink = state.requestTraceContext;
    const startSpan = () =>
      input.tracer.startSpan(
        AGENT_SPAN_NAMES.channelDelivery,
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
          root: parent === undefined,
          startTime: state.startTimeMs,
        },
        withChannelAudience(
          parent === undefined ? ROOT_CONTEXT : contextFromSpanContext(parent),
          state.channelAudience,
        ),
      );
    const span = input.idGenerator.withSpanId(state.spanId, () =>
      parent === undefined
        ? input.idGenerator.withTraceId(traceContext.traceId, startSpan)
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
      recordError(span, event.error, errorType);
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

function isOnlyActiveDelivery(sessionId: string, turnId: string, deliveryId: string): boolean {
  const active = contextStorage.getStore()?.get(ActiveChannelDeliveriesKey);
  const delivery = active?.[0];
  return (
    active?.length === 1 &&
    delivery?.sessionId === sessionId &&
    delivery.turnId === turnId &&
    delivery.delivery.deliveryId === deliveryId
  );
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
