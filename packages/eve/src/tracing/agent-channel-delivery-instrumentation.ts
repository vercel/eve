import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

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
import { contentAttribute } from "#tracing/agent-otel-content.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";

interface ChannelDeliveryState {
  readonly inputAttribute?: string;
  readonly requestTraceContext?: SpanContext;
}

/** Captures one-to-one channel delivery metadata on the activation that consumes it. */
export function createAgentChannelDeliveryInstrumentation(input: {
  readonly ensureSessionContext: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<AgentSessionTraceState>;
  readonly recordInputs: boolean;
  readonly stateStore: AgentTraceStateStore;
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
      traceSeed: event.traceSeed,
      type: "session.started",
    });
    const turn =
      event.turnId === undefined || event.sequence === undefined
        ? undefined
        : await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (!isSampledTrace(turn?.context ?? session.context)) return;
    const inputAttribute = input.recordInputs ? contentAttribute(event.input, false) : undefined;
    const state: Record<string, JsonValue> = {};
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
    if (state === undefined || event.turnId === undefined) return;
    const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (
      turn === undefined ||
      !isSampledTrace(turn.context) ||
      !isOnlyActiveDelivery(event.sessionId, event.turnId, event.delivery.deliveryId)
    ) {
      return;
    }
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

function readState(value: unknown): ChannelDeliveryState | undefined {
  if (!isRecord(value)) return undefined;
  const requestTraceContext = isSpanContext(value.requestTraceContext)
    ? value.requestTraceContext
    : undefined;
  return {
    inputAttribute: typeof value.inputAttribute === "string" ? value.inputAttribute : undefined,
    requestTraceContext,
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
