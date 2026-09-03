import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type { SessionTraceContext } from "#channel/types.js";
import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ContextAccessor } from "#context/key.js";
import { SessionTraceSeedKey, type SessionTraceSeed } from "#context/keys.js";
import type {
  AgentActionTraceState,
  AgentActionTraceTerminalState,
  AgentInvocationTraceState,
  AgentSessionTraceState,
  AgentTraceStateStore,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  decisionToTraceContentCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import {
  deserializeAgentTraceContextState,
  emptyAgentTraceContextState,
  serializeAgentTraceContextState,
  type AgentTraceContextState,
} from "#tracing/agent-trace-context-codec.js";

const AgentTraceContextKey = new ContextKey<AgentTraceContextState>("eve.harness.agentTrace", {
  codec: {
    deserialize: deserializeAgentTraceContextState,
    serialize: serializeAgentTraceContextState,
  },
});

/** Reads the decision already bound to a session in the current worker context. */
export function readCurrentSessionTraceDecision(
  sessionId: string,
): InstrumentationDecision | undefined {
  const context = contextStorage.getStore();
  return context === undefined ? undefined : readSessionTraceDecision(context, sessionId);
}

export function readSessionTraceDecision(
  context: ContextAccessor,
  sessionId: string,
): InstrumentationDecision | undefined {
  return context.get(AgentTraceContextKey)?.sessions[sessionId]?.decision;
}

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
): SessionTraceContext | undefined {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return undefined;
  const session = deserializeAgentTraceContextState(raw).sessions[sessionId];
  return session === undefined
    ? undefined
    : withTraceDecision(serializedContext, session.context, session.decision);
}

/** Reads the durable action span that should parent a dispatched child agent. */
export function readActionTraceContext(
  serializedContext: Readonly<Record<string, unknown>>,
  sessionId: string,
  turnId: string,
  callId: string,
): SessionTraceContext | undefined {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return undefined;
  const state = deserializeAgentTraceContextState(raw);
  const action = [
    ...Object.values(state.invocations),
    ...Object.values(state.actions),
    ...Object.values(state.actionAnchors),
  ].find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.turnId === turnId &&
      candidate.callId === callId,
  );
  if (action === undefined) return undefined;
  return withTraceDecision(
    serializedContext,
    {
      isRemote: false,
      spanId: action.spanId,
      traceFlags: action.parent.traceFlags,
      traceId: action.parent.traceId,
    },
    state.sessions[action.sessionId]?.decision,
  );
}

export function recordActionChildTraceId(
  serializedContext: Record<string, unknown>,
  sessionId: string,
  turnId: string,
  callId: string,
  childTraceId: string,
): Record<string, unknown> {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return serializedContext;
  const state = deserializeAgentTraceContextState(raw);
  const actionEntry = Object.entries(state.actions).find(
    ([, action]) =>
      action.sessionId === sessionId && action.turnId === turnId && action.callId === callId,
  );
  if (actionEntry !== undefined) {
    const [key, action] = actionEntry;
    return {
      ...serializedContext,
      [AgentTraceContextKey.name]: serializeAgentTraceContextState({
        ...state,
        actions: { ...state.actions, [key]: { ...action, childTraceId } },
      }),
    };
  }
  const invocationEntry = Object.entries(state.invocations).find(
    ([, invocation]) =>
      invocation.sessionId === sessionId &&
      invocation.turnId === turnId &&
      invocation.callId === callId,
  );
  if (invocationEntry === undefined) return serializedContext;
  const [key, invocation] = invocationEntry;
  return {
    ...serializedContext,
    [AgentTraceContextKey.name]: serializeAgentTraceContextState({
      ...state,
      invocations: { ...state.invocations, [key]: { ...invocation, childTraceId } },
    }),
  };
}

export function recordNestedAgentInvocation(input: {
  readonly callId: string;
  readonly kind: "remote-agent-call" | "subagent-call";
  readonly name: string;
  readonly outerCallId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly spanId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  const raw = input.serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return input.serializedContext;
  const state = deserializeAgentTraceContextState(raw);
  const outer = [...Object.values(state.actions), ...Object.values(state.actionAnchors)].find(
    (action) =>
      action.sessionId === input.sessionId &&
      action.turnId === input.turnId &&
      action.callId === input.outerCallId,
  );
  if (outer === undefined) return input.serializedContext;
  const key = actionIdempotencyKey(input.sessionId, input.turnId, input.callId);
  if (state.invocations[key] !== undefined) return input.serializedContext;
  const invocation: AgentInvocationTraceState = {
    attemptIndex: outer.attemptIndex,
    callId: input.callId,
    channelAudience: outer.channelAudience,
    kind: input.kind,
    name: input.name,
    parent: {
      spanId: outer.spanId,
      traceFlags: outer.parent.traceFlags,
      traceId: outer.parent.traceId,
    },
    parentActionCallId: input.outerCallId,
    rootSessionId: outer.rootSessionId,
    sessionId: outer.sessionId,
    spanId: input.spanId,
    startTimeMs: Date.now(),
    stepIndex: outer.stepIndex,
    turnId: outer.turnId,
  };
  return {
    ...input.serializedContext,
    [AgentTraceContextKey.name]: serializeAgentTraceContextState({
      ...state,
      invocations: { ...state.invocations, [key]: invocation },
    }),
  };
}

export function recordNestedAgentInvocationTerminal(input: {
  readonly callId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly terminal: AgentActionTraceTerminalState;
  readonly turnId?: string;
}): Record<string, unknown> {
  const raw = input.serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return input.serializedContext;
  const state = deserializeAgentTraceContextState(raw);
  const entry = Object.entries(state.invocations).find(
    ([, invocation]) =>
      invocation.sessionId === input.sessionId &&
      (input.turnId === undefined || invocation.turnId === input.turnId) &&
      invocation.callId === input.callId,
  );
  if (entry === undefined) return input.serializedContext;
  const [key, invocation] = entry;
  return {
    ...input.serializedContext,
    [AgentTraceContextKey.name]: serializeAgentTraceContextState({
      ...state,
      invocations: {
        ...state.invocations,
        [key]: { ...invocation, terminal: input.terminal },
      },
    }),
  };
}

export function recordActionInvocationKind(input: {
  readonly callId: string;
  readonly kind: "remote-agent-call" | "subagent-call";
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  const raw = input.serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return input.serializedContext;
  const state = deserializeAgentTraceContextState(raw);
  const update = (action: AgentActionTraceState): AgentActionTraceState =>
    action.sessionId === input.sessionId &&
    action.turnId === input.turnId &&
    action.callId === input.callId
      ? { ...action, kind: input.kind }
      : action;
  return {
    ...input.serializedContext,
    [AgentTraceContextKey.name]: serializeAgentTraceContextState({
      ...state,
      actionAnchors: Object.fromEntries(
        Object.entries(state.actionAnchors).map(([key, action]) => [key, update(action)]),
      ),
      actions: Object.fromEntries(
        Object.entries(state.actions).map(([key, action]) => [key, update(action)]),
      ),
    }),
  };
}

function withTraceDecision(
  serializedContext: Readonly<Record<string, unknown>>,
  context: SpanContext,
  storedDecision?: InstrumentationDecision,
): SessionTraceContext {
  const seed = serializedContext[SessionTraceSeedKey.name] as SessionTraceSeed | undefined;
  const traceState = resolveForwardedTraceSeed({
    decision: storedDecision ?? seed?.decision,
    forwardedTracePolicy: seed?.forwardedTracePolicy,
    traceFlags: context.traceFlags,
  })!;
  const decision = traceState.decision;
  const forwardedTracePolicy = traceState.forwardedTracePolicy;
  const ceiling = decisionToTraceContentCeiling(decision);
  const resolvedContext = { ...context, traceFlags: traceState.traceFlags };
  if (forwardedTracePolicy === undefined) {
    return decision === undefined ? resolvedContext : { ...resolvedContext, decision };
  }
  const narrowedForwardedTracePolicy =
    ceiling === undefined ? forwardedTracePolicy : { ...forwardedTracePolicy, ceiling };
  if (decision === undefined) {
    return { ...resolvedContext, forwardedTracePolicy: narrowedForwardedTracePolicy };
  }
  return {
    ...resolvedContext,
    decision,
    forwardedTracePolicy: narrowedForwardedTracePolicy,
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

  deleteActionAnchors(sessionId: string): void {
    updateState((state) => ({
      ...state,
      actionAnchors: Object.fromEntries(
        Object.entries(state.actionAnchors).filter(([, anchor]) => anchor.sessionId !== sessionId),
      ),
    }));
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

  deleteInvocation(idempotencyKey: string): void {
    updateState((state) => {
      const invocations = { ...state.invocations };
      delete invocations[idempotencyKey];
      return { ...state, invocations };
    });
  }

  deleteInvocations(sessionId: string, turnId?: string): void {
    updateState((state) => ({
      ...state,
      invocations: Object.fromEntries(
        Object.entries(state.invocations).filter(
          ([, invocation]) =>
            invocation.sessionId !== sessionId ||
            (turnId !== undefined && invocation.turnId !== turnId),
        ),
      ),
    }));
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

  findActionAnchor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): AgentActionTraceState | undefined {
    return Object.values(
      contextStorage.getStore()?.get(AgentTraceContextKey)?.actionAnchors ?? {},
    ).find(
      (anchor) =>
        anchor.sessionId === sessionId && anchor.turnId === turnId && anchor.callId === callId,
    );
  }

  findInvocations(
    sessionId: string,
    turnId?: string,
    parentActionCallId?: string,
  ): readonly AgentInvocationTraceState[] {
    return Object.values(
      contextStorage.getStore()?.get(AgentTraceContextKey)?.invocations ?? {},
    ).filter(
      (invocation) =>
        invocation.sessionId === sessionId &&
        (turnId === undefined || invocation.turnId === turnId) &&
        (parentActionCallId === undefined || invocation.parentActionCallId === parentActionCallId),
    );
  }

  getAction(idempotencyKey: string): AgentActionTraceState | undefined {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.actions[idempotencyKey];
  }

  getInvocation(idempotencyKey: string): AgentInvocationTraceState | undefined {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.invocations[idempotencyKey];
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

  setActionAnchor(idempotencyKey: string, value: AgentActionTraceState): void {
    updateState((state) => ({
      ...state,
      actionAnchors: { ...state.actionAnchors, [idempotencyKey]: value },
    }));
  }

  setInvocation(idempotencyKey: string, value: AgentInvocationTraceState): void {
    updateState((state) => ({
      ...state,
      invocations: { ...state.invocations, [idempotencyKey]: value },
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

  updateTurn(
    sessionId: string,
    turnId: string,
    update: (state: AgentTurnTraceState) => AgentTurnTraceState,
  ): void {
    updateState((state) => {
      const key = turnKey(sessionId, turnId);
      const current = state.turns[key];
      return current === undefined
        ? state
        : { ...state, turns: { ...state.turns, [key]: update(current) } };
    });
  }
}

function updateState(update: (state: AgentTraceContextState) => AgentTraceContextState): void {
  loadContext().set(AgentTraceContextKey, (state) =>
    update(state ?? emptyAgentTraceContextState()),
  );
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}
