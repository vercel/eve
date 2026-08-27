import {
  ROOT_CONTEXT,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationHandlerContext,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationProviderDefinition,
} from "#harness/instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";

interface AgentApprovalSpanState {
  readonly actionCallId: string;
  readonly actionName: string;
  readonly attemptIndex: number;
  readonly channelAudience: ChannelAudience;
  readonly parent: SpanContext;
  readonly requestAttribute?: string;
  readonly requestId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly startTimeMs: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** Builds durable approval wait spans under their originating runtime action. */
export function createAgentApprovalInstrumentation(input: {
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly tracer: Tracer;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "input.requested" | "input.resolved"
> {
  const onRequested = async (
    event: InstrumentationInputRequestedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> => {
    if (event.kind !== "tool-approval" || readState(ctx.state.get()) !== undefined) return;
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.action.callId,
    );
    if (parent === undefined) return;
    const state: Record<string, JsonValue> = {
      actionCallId: event.action.callId,
      actionName: event.action.name,
      attemptIndex: event.scope.attemptIndex,
      channelAudience: normalizeChannelAudience(event.scope.channelAudience),
      parent: {
        spanId: parent.spanContext.spanId,
        traceFlags: parent.spanContext.traceFlags,
        traceId: parent.spanContext.traceId,
      },
      requestId: event.requestId,
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      sessionId: event.scope.sessionId,
      startTimeMs: Date.now(),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    const requestAttribute = input.recordInputs
      ? contentAttribute(event.request, false)
      : undefined;
    if (requestAttribute !== undefined) state["requestAttribute"] = requestAttribute;
    ctx.state.set(state);
  };

  const onResolved = (
    event: InstrumentationInputResolvedEvent,
    ctx: InstrumentationHandlerContext,
  ): void => {
    const state = readState(ctx.state.get());
    if (state === undefined) return;
    const span = input.idGenerator.withSpanId(
      input.idGenerator.deriveSpanId(`approval:${event.idempotencyKey}`),
      () =>
        input.tracer.startSpan(
          "agent.approval",
          {
            attributes: {
              "agent.action.call_id": state.actionCallId,
              "agent.action.name": state.actionName,
              "agent.approval.kind": "tool-approval",
              "agent.approval.outcome": event.outcome,
              "agent.approval.request_id": state.requestId,
              "agent.framework.name": "eve",
              "agent.framework.version": input.frameworkVersion,
              "agent.session.id": state.sessionId,
              "agent.step.attempt": state.attemptIndex,
              "agent.step.index": state.stepIndex,
              "agent.turn.id": state.turnId,
            },
            startTime: state.startTimeMs,
          },
          trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ ...state.parent, isRemote: false })),
        ),
    );
    if (state.requestAttribute !== undefined) {
      span.setAttribute("agent.approval.request", state.requestAttribute);
    }
    if (input.recordOutputs && event.response !== undefined) {
      const response = contentAttribute(event.response, false);
      if (response !== undefined) span.setAttribute("agent.approval.response", response);
    }
    if (event.outcome === "failed") recordError(span, event.error);
    span.end();
  };

  return {
    "input.requested": onRequested,
    "input.resolved": onResolved,
  };
}

function readState(value: unknown): AgentApprovalSpanState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const parent = state["parent"];
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return undefined;
  const parentRecord = parent as Record<string, unknown>;
  if (
    typeof state["actionCallId"] !== "string" ||
    typeof state["actionName"] !== "string" ||
    typeof state["attemptIndex"] !== "number" ||
    typeof parentRecord["spanId"] !== "string" ||
    typeof parentRecord["traceFlags"] !== "number" ||
    typeof parentRecord["traceId"] !== "string" ||
    typeof state["requestId"] !== "string" ||
    typeof state["rootSessionId"] !== "string" ||
    typeof state["sessionId"] !== "string" ||
    typeof state["startTimeMs"] !== "number" ||
    typeof state["stepIndex"] !== "number" ||
    typeof state["turnId"] !== "string"
  ) {
    return undefined;
  }
  const requestAttribute = state["requestAttribute"];
  if (requestAttribute !== undefined && typeof requestAttribute !== "string") return undefined;
  return {
    actionCallId: state["actionCallId"],
    actionName: state["actionName"],
    attemptIndex: state["attemptIndex"],
    channelAudience: normalizeChannelAudience(state["channelAudience"]),
    parent: {
      isRemote: false,
      spanId: parentRecord["spanId"],
      traceFlags: parentRecord["traceFlags"],
      traceId: parentRecord["traceId"],
    },
    requestAttribute,
    requestId: state["requestId"],
    rootSessionId: state["rootSessionId"],
    sessionId: state["sessionId"],
    startTimeMs: state["startTimeMs"],
    stepIndex: state["stepIndex"],
    turnId: state["turnId"],
  };
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
