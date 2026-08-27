import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type {
  AgentActionTraceState,
  AgentSessionTraceState,
  AgentTraceStateStore,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

interface AgentTraceContextState {
  readonly actions: Readonly<Record<string, AgentActionTraceState>>;
  readonly sessions: Readonly<Record<string, AgentSessionTraceState>>;
  readonly turns: Readonly<Record<string, AgentTurnTraceState>>;
}

const AgentTraceContextKey = new ContextKey<AgentTraceContextState>("eve.harness.agentTrace", {
  codec: {
    deserialize: deserializeState,
    serialize: serializeState,
  },
});

/** Keeps only framework trace state from an interrupted step's context changes. */
export function preserveSerializedAgentTraceState(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  const traceState = interrupted[AgentTraceContextKey.name];
  return traceState === undefined
    ? original
    : { ...original, [AgentTraceContextKey.name]: traceState };
}

/**
 * Reads a named session's trace context straight out of a serialized context,
 * which {@link ContextAgentTraceStateStore} cannot do — its reads are scoped
 * to the ambient session.
 */
export function readSessionTraceContext(
  serializedContext: Readonly<Record<string, unknown>>,
  sessionId: string,
): SpanContext | undefined {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return undefined;
  return deserializeState(raw).sessions[sessionId]?.context;
}

/** Reads the durable action span that should parent a dispatched child agent. */
export function readActionTraceContext(
  serializedContext: Readonly<Record<string, unknown>>,
  sessionId: string,
  turnId: string,
  callId: string,
): SpanContext | undefined {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return undefined;
  const action = Object.values(deserializeState(raw).actions).find(
    (state) => state.sessionId === sessionId && state.turnId === turnId && state.callId === callId,
  );
  if (action === undefined) return undefined;
  return {
    isRemote: false,
    spanId: action.spanId,
    traceFlags: action.parent.traceFlags,
    traceId: action.parent.traceId,
  };
}

/** Durable trace state backed by eve's serialized Workflow context. */
export class ContextAgentTraceStateStore implements AgentTraceStateStore {
  deleteAction(idempotencyKey: string): void {
    updateState((state) => {
      const actions = { ...state.actions };
      delete actions[idempotencyKey];
      return { ...state, actions };
    });
  }

  deleteActions(sessionId: string, turnId?: string): void {
    updateState((state) => {
      const actions = { ...state.actions };
      for (const [key, action] of Object.entries(actions)) {
        if (action.sessionId === sessionId && (turnId === undefined || action.turnId === turnId)) {
          delete actions[key];
        }
      }
      return { ...state, actions };
    });
  }

  deleteSession(sessionId: string): void {
    updateState((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { ...state, sessions };
    });
  }

  deleteTurn(sessionId: string, turnId: string): void {
    updateState((state) => {
      const turns = { ...state.turns };
      delete turns[turnKey(sessionId, turnId)];
      return { ...state, turns };
    });
  }

  findAction(sessionId: string, callId: string): AgentActionTraceState | undefined {
    return Object.values(contextStorage.getStore()?.get(AgentTraceContextKey)?.actions ?? {}).find(
      (state) => state.sessionId === sessionId && state.callId === callId,
    );
  }

  getAction(idempotencyKey: string): AgentActionTraceState | undefined {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.actions[idempotencyKey];
  }

  getSession(sessionId: string): AgentSessionTraceState | undefined {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.sessions[sessionId];
  }

  getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.turns[turnKey(sessionId, turnId)];
  }

  setAction(idempotencyKey: string, value: AgentActionTraceState): void {
    updateState((state) => ({
      ...state,
      actions: { ...state.actions, [idempotencyKey]: value },
    }));
  }

  setSession(sessionId: string, value: AgentSessionTraceState): void {
    updateState((state) => ({
      ...state,
      sessions: { ...state.sessions, [sessionId]: value },
    }));
  }

  setTurn(sessionId: string, turnId: string, value: AgentTurnTraceState): void {
    updateState((state) => ({
      ...state,
      turns: { ...state.turns, [turnKey(sessionId, turnId)]: value },
    }));
  }
}

function updateState(update: (state: AgentTraceContextState) => AgentTraceContextState): void {
  loadContext().set(AgentTraceContextKey, (state) =>
    update(state ?? { actions: {}, sessions: {}, turns: {} }),
  );
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}

function serializeState(state: AgentTraceContextState): unknown {
  return {
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

function deserializeState(data: unknown): AgentTraceContextState {
  if (!isRecord(data)) return { actions: {}, sessions: {}, turns: {} };
  const actions = deserializeRecord(data.actions, deserializeAction);
  const sessions = deserializeRecord(data.sessions, (value) => {
    if (!isRecord(value) || !isSpanContext(value.context)) return undefined;
    return {
      agentName: typeof value.agentName === "string" ? value.agentName : undefined,
      channelAudience: normalizeChannelAudience(value.channelAudience),
      channelKind: typeof value.channelKind === "string" ? value.channelKind : undefined,
      context: value.context,
      rootSessionId: typeof value.rootSessionId === "string" ? value.rootSessionId : "",
    } satisfies AgentSessionTraceState;
  });
  const turns = deserializeRecord(data.turns, (value) => {
    if (!isRecord(value) || !isSpanContext(value.context)) return undefined;
    if (typeof value.parentSpanId !== "string" || typeof value.startTimeMs !== "number") {
      return undefined;
    }
    return {
      context: value.context,
      parentIsRemote: typeof value.parentIsRemote === "boolean" ? value.parentIsRemote : undefined,
      parentSpanId: value.parentSpanId,
      rootSessionId: typeof value.rootSessionId === "string" ? value.rootSessionId : "",
      sequence: typeof value.sequence === "number" ? value.sequence : 0,
      startTimeMs: value.startTimeMs,
      subagentName: typeof value.subagentName === "string" ? value.subagentName : undefined,
      terminal: deserializeTerminal(value.terminal),
    } satisfies AgentTurnTraceState;
  });
  return { actions, sessions, turns };
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
  };
}

function isActionKind(value: unknown): value is AgentActionTraceState["kind"] {
  return (
    value === "load-skill" ||
    value === "remote-agent-call" ||
    value === "subagent-call" ||
    value === "tool-call"
  );
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

function deserializeTerminal(value: unknown): AgentTurnTraceState["terminal"] {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const type = value.type;
  if (!isTurnTerminalType(type)) return undefined;
  return type === "turn.failed" ? { error: deserializeError(value.error), type } : { type };
}

function serializeSpanContext(context: SpanContext): Record<string, unknown> {
  return {
    isRemote: context.isRemote,
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

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { message: error.message, name: error.name, stack: error.stack }
    : undefined;
}

function deserializeError(value: unknown): Error | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const error = new Error(value.message);
  if (typeof value.name === "string") error.name = value.name;
  if (typeof value.stack === "string") error.stack = value.stack;
  return error;
}

function isTurnTerminalType(
  value: string,
): value is "turn.cancelled" | "turn.completed" | "turn.failed" {
  return value === "turn.cancelled" || value === "turn.completed" || value === "turn.failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
