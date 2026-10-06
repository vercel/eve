import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type {
  AgentActionTraceState,
  AgentSessionTraceState,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { boundedTraceError } from "#tracing/bounded-error.js";
import { boundedPrincipalId } from "#tracing/telemetry-budget.js";
import { isInstrumentationPrincipalType } from "#instrumentation/lifecycle.js";

export const AGENT_TRACE_CONTEXT_KEY = "eve.harness.agentTrace";

export function decodeTraceSessionId(state: {
  readonly traceSessionId?: unknown;
  readonly rootSessionId?: unknown;
}): string {
  // Persisted state from before trace-session identity uses the lineage root.
  return typeof state.traceSessionId === "string"
    ? state.traceSessionId
    : typeof state.rootSessionId === "string"
      ? state.rootSessionId
      : "";
}

export interface AgentTraceContextState {
  readonly actionAnchors: Readonly<Record<string, AgentActionTraceState>>;
  readonly actions: Readonly<Record<string, AgentActionTraceState>>;
  readonly sessions: Readonly<Record<string, AgentSessionTraceState>>;
  readonly turns: Readonly<Record<string, AgentTurnTraceState>>;
}

export function emptyAgentTraceContextState(): AgentTraceContextState {
  return { actionAnchors: {}, actions: {}, sessions: {}, turns: {} };
}

export function serializeAgentTraceContextState(state: AgentTraceContextState): unknown {
  return {
    actionAnchors: state.actionAnchors,
    actions: state.actions,
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
    channelType: typeof value.channelType === "string" ? value.channelType : undefined,
    context: value.context,
    decision: readInstrumentationDecision(value.decision),
    parentLineage: deserializeParentLineage(value.parentLineage),
    rootSessionId: typeof value.rootSessionId === "string" ? value.rootSessionId : "",
    traceSessionId: decodeTraceSessionId(value),
    scheduleId: typeof value.scheduleId === "string" ? value.scheduleId : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
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
    traceSessionId: decodeTraceSessionId(value),
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
    traceSessionId: decodeTraceSessionId(value),
    sessionId: value.sessionId,
    spanId: value.spanId,
    startTimeMs: value.startTimeMs,
    stepIndex: value.stepIndex,
    turnId: value.turnId,
    toolEndTimeMs: typeof value.toolEndTimeMs === "number" ? value.toolEndTimeMs : undefined,
    toolFailed: value.toolFailed === true,
    toolErrorAttribute:
      typeof value.toolErrorAttribute === "string" ? value.toolErrorAttribute : undefined,
    toolAttributes: isRecord(value.toolAttributes)
      ? Object.fromEntries(
          Object.entries(value.toolAttributes).filter(
            (
              entry,
            ): entry is [string, NonNullable<AgentActionTraceState["toolAttributes"]>[string]] => {
              const attribute = entry[1];
              return (
                typeof attribute === "string" ||
                typeof attribute === "number" ||
                typeof attribute === "boolean" ||
                (Array.isArray(attribute) &&
                  attribute.every((entry) =>
                    ["string", "number", "boolean"].includes(typeof entry),
                  ))
              );
            },
          ),
        )
      : undefined,
  };
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
