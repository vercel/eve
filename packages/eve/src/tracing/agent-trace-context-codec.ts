import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type {
  AgentActionTraceState,
  AgentActionTraceTerminalState,
  AgentInvocationTraceState,
  AgentSessionTraceState,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { boundedTraceError } from "#tracing/bounded-error.js";
import { boundedPrincipalId } from "#tracing/telemetry-budget.js";
import { isInstrumentationPrincipalType } from "#instrumentation/lifecycle.js";

export const AGENT_TRACE_CONTEXT_KEY = "eve.harness.agentTrace";

export interface AgentTraceContextState {
  readonly actionAnchors: Readonly<Record<string, AgentActionTraceState>>;
  readonly actions: Readonly<Record<string, AgentActionTraceState>>;
  readonly invocations: Readonly<Record<string, AgentInvocationTraceState>>;
  readonly sessions: Readonly<Record<string, AgentSessionTraceState>>;
  readonly turns: Readonly<Record<string, AgentTurnTraceState>>;
}

export function emptyAgentTraceContextState(): AgentTraceContextState {
  return { actionAnchors: {}, actions: {}, invocations: {}, sessions: {}, turns: {} };
}

export function serializeAgentTraceContextState(state: AgentTraceContextState): unknown {
  return {
    actionAnchors: state.actionAnchors,
    actions: state.actions,
    invocations: Object.fromEntries(
      Object.entries(state.invocations).map(([id, value]) => [
        id,
        {
          ...value,
          terminal:
            value.terminal === undefined
              ? undefined
              : {
                  ...value.terminal,
                  error:
                    value.recordOutputs === true ? serializeError(value.terminal.error) : undefined,
                },
        },
      ]),
    ),
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([id, value]) => [
        id,
        { ...value, context: serializeSpanContext(value.context) },
      ]),
    ),
    turns: Object.fromEntries(
      Object.entries(state.turns).map(([id, value]) => [
        id,
        {
          ...value,
          caller: value.caller === undefined ? undefined : serializeSpanContext(value.caller),
          channelDelivery:
            value.channelDelivery === undefined
              ? undefined
              : {
                  ...value.channelDelivery,
                  requestTraceContext:
                    value.channelDelivery.requestTraceContext === undefined
                      ? undefined
                      : serializeSpanContext(value.channelDelivery.requestTraceContext),
                },
          context: serializeSpanContext(value.context),
          terminal:
            value.terminal === undefined
              ? undefined
              : value.terminal.type === "turn.failed"
                ? { error: serializeError(value.terminal.error), type: value.terminal.type }
                : { type: value.terminal.type },
        },
      ]),
    ),
  };
}

export function deserializeAgentTraceContextState(data: unknown): AgentTraceContextState {
  if (!isRecord(data)) return emptyAgentTraceContextState();
  return {
    actionAnchors: deserializeRecord(data.actionAnchors, deserializeAction),
    actions: deserializeRecord(data.actions, deserializeAction),
    invocations: deserializeRecord(data.invocations, deserializeInvocation),
    sessions: deserializeRecord(data.sessions, deserializeSession),
    turns: deserializeRecord(data.turns, deserializeTurn),
  };
}

function deserializeSession(value: unknown): AgentSessionTraceState | undefined {
  if (!isRecord(value) || !isSpanContext(value.context)) return undefined;
  return {
    agentName: typeof value.agentName === "string" ? value.agentName : undefined,
    channelAudience: normalizeChannelAudience(value.channelAudience),
    channelKind: typeof value.channelKind === "string" ? value.channelKind : undefined,
    context: value.context,
    decision: readInstrumentationDecision(value.decision),
    parentLineage: deserializeParentLineage(value.parentLineage),
    rootSessionId: typeof value.rootSessionId === "string" ? value.rootSessionId : "",
  };
}

function deserializeTurn(value: unknown): AgentTurnTraceState | undefined {
  if (!isRecord(value) || !isSpanContext(value.context) || typeof value.startTimeMs !== "number") {
    return undefined;
  }
  return {
    caller: isSpanContext(value.caller) ? value.caller : undefined,
    channelDelivery: deserializeTurnChannelDelivery(value.channelDelivery),
    context: value.context,
    currentPrincipal: deserializePrincipalSummary(value.currentPrincipal),
    initiatorPrincipal: deserializePrincipalSummary(value.initiatorPrincipal),
    modelUsage: deserializeModelUsage(value.modelUsage),
    parentLineage: deserializeParentLineage(value.parentLineage),
    rootSessionId: typeof value.rootSessionId === "string" ? value.rootSessionId : "",
    sequence: typeof value.sequence === "number" ? value.sequence : 0,
    startTimeMs: value.startTimeMs,
    subagentName: typeof value.subagentName === "string" ? value.subagentName : undefined,
    terminal: deserializeTurnTerminal(value.terminal),
  };
}

function deserializeTurnChannelDelivery(value: unknown): AgentTurnTraceState["channelDelivery"] {
  if (
    !isRecord(value) ||
    typeof value.channelKind !== "string" ||
    typeof value.channelName !== "string" ||
    typeof value.deliveryId !== "string"
  ) {
    return undefined;
  }
  return {
    channelKind: value.channelKind,
    channelName: value.channelName,
    deliveryId: value.deliveryId,
    inputAttribute: typeof value.inputAttribute === "string" ? value.inputAttribute : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    requestTraceContext: isSpanContext(value.requestTraceContext)
      ? value.requestTraceContext
      : undefined,
  };
}

function deserializePrincipalSummary(
  value: unknown,
): AgentTurnTraceState["currentPrincipal"] | undefined {
  if (!isRecord(value) || !isInstrumentationPrincipalType(value.type)) return undefined;
  const id = value.type === "none" ? undefined : boundedPrincipalId(value.id);
  return id === undefined ? { type: value.type } : { id, type: value.type };
}

function deserializeAction(value: unknown): AgentActionTraceState | undefined {
  if (
    !isRecord(value) ||
    typeof value.attemptIndex !== "number" ||
    typeof value.callId !== "string" ||
    !isActionKind(value.kind) ||
    typeof value.name !== "string" ||
    !isSpanContext(value.parent) ||
    typeof value.rootSessionId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.spanId !== "string" ||
    typeof value.startTimeMs !== "number" ||
    typeof value.stepIndex !== "number" ||
    typeof value.turnId !== "string"
  ) {
    return undefined;
  }
  return {
    attemptIndex: value.attemptIndex,
    callId: value.callId,
    channelAudience: normalizeChannelAudience(value.channelAudience),
    inputAttribute: typeof value.inputAttribute === "string" ? value.inputAttribute : undefined,
    kind: value.kind,
    name: value.name,
    parent: value.parent,
    rootSessionId: value.rootSessionId,
    sessionId: value.sessionId,
    spanId: value.spanId,
    startTimeMs: value.startTimeMs,
    stepIndex: value.stepIndex,
    turnId: value.turnId,
    workflowName: typeof value.workflowName === "string" ? value.workflowName : undefined,
  };
}

function deserializeInvocation(value: unknown): AgentInvocationTraceState | undefined {
  const action = deserializeAction(value);
  if (
    action === undefined ||
    (action.kind !== "subagent-call" && action.kind !== "remote-agent-call") ||
    !isRecord(value) ||
    typeof value.parentActionCallId !== "string"
  ) {
    return undefined;
  }
  return {
    attemptIndex: action.attemptIndex,
    callId: action.callId,
    channelAudience: action.channelAudience,
    kind: action.kind,
    name: action.name,
    parent: action.parent,
    parentActionCallId: value.parentActionCallId,
    recordOutputs: value.recordOutputs === true,
    rootSessionId: action.rootSessionId,
    sessionId: action.sessionId,
    spanId: action.spanId,
    startTimeMs: action.startTimeMs,
    stepIndex: action.stepIndex,
    terminal: deserializeActionTerminal(value.terminal),
    turnId: action.turnId,
  };
}

function deserializeActionTerminal(value: unknown): AgentActionTraceTerminalState | undefined {
  if (!isRecord(value) || !isActionOutcome(value.outcome)) return undefined;
  return {
    acceptedAtMs: typeof value.acceptedAtMs === "number" ? value.acceptedAtMs : undefined,
    error: deserializeError(value.error),
    outcome: value.outcome,
    usage: isRecord(value.usage) ? value.usage : undefined,
  } as AgentActionTraceTerminalState;
}

function deserializeModelUsage(
  value: unknown,
): NonNullable<AgentTurnTraceState["modelUsage"]> | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = typeof value.inputTokens === "number" ? value.inputTokens : undefined;
  const outputTokens = typeof value.outputTokens === "number" ? value.outputTokens : undefined;
  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

function deserializeParentLineage(value: unknown): AgentSessionTraceState["parentLineage"] {
  if (
    !isRecord(value) ||
    typeof value.callId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.turnId !== "string"
  ) {
    return undefined;
  }
  return {
    callId: value.callId,
    sessionId: value.sessionId,
    subagentName: typeof value.subagentName === "string" ? value.subagentName : undefined,
    turnId: value.turnId,
  };
}

function deserializeTurnTerminal(value: unknown): AgentTurnTraceState["terminal"] {
  if (!isRecord(value) || !isTurnTerminalType(value.type)) return undefined;
  return value.type === "turn.failed"
    ? { error: deserializeError(value.error), type: value.type }
    : { type: value.type };
}

function deserializeRecord<T>(
  value: unknown,
  deserialize: (entry: unknown) => T | undefined,
): Record<string, T> {
  if (!isRecord(value)) return {};
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = deserialize(entry);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function serializeSpanContext(context: SpanContext): Record<string, unknown> {
  return {
    isRemote: context.isRemote,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
  };
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  const bounded = boundedTraceError(error);
  return { message: bounded.message, name: bounded.name, stack: bounded.stack };
}

function deserializeError(value: unknown): Error | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const error = new Error(value.message);
  if (typeof value.name === "string") error.name = value.name;
  if (typeof value.stack === "string") error.stack = value.stack;
  return error;
}

function isActionKind(value: unknown): value is AgentActionTraceState["kind"] {
  return (
    value === "load-skill" ||
    value === "remote-agent-call" ||
    value === "subagent-call" ||
    value === "tool-call"
  );
}

function isActionOutcome(value: unknown): value is AgentActionTraceTerminalState["outcome"] {
  return (
    value === "abandoned" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "failed" ||
    value === "rejected"
  );
}

function isTurnTerminalType(
  value: unknown,
): value is "turn.cancelled" | "turn.completed" | "turn.failed" {
  return value === "turn.cancelled" || value === "turn.completed" || value === "turn.failed";
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
