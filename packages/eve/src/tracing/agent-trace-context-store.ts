import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type { SessionTraceContext } from "#channel/types.js";
import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ContextAccessor } from "#context/key.js";
import { SessionTraceSeedKey, type SessionTraceSeed } from "#context/keys.js";
import type {
  AgentActionTraceState,
  AgentSessionTraceState,
  AgentTraceStateStore,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

import { createLogger } from "#internal/logging.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  decisionToTraceContentCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import {
  deserializeAgentTraceContextState,
  AGENT_TRACE_CONTEXT_KEY,
  emptyAgentTraceContextState,
  serializeAgentTraceContextState,
  type AgentTraceContextState,
} from "#tracing/agent-trace-context-codec.js";

const AgentTraceContextKey = new ContextKey<AgentTraceContextState>(AGENT_TRACE_CONTEXT_KEY, {
  codec: {
    deserialize: deserializeAgentTraceContextState,
    serialize: serializeAgentTraceContextState,
  },
});

/** Run after task-provider commits, so a pending workflow tool call keeps its anchor. */
export function pruneAgentTraceState(
  context: ContextAccessor,
  sessionId: string,
  sessionState: SessionStateMap | undefined,
): void {
  try {
    pruneTraceOwnership(context, sessionId, sessionState);
  } catch (error) {
    createLogger("tracing.retention").warn(
      "could not reconcile trace ownership; preserving trace state",
      { error },
    );
  }
}

function pruneTraceOwnership(
  context: ContextAccessor,
  sessionId: string,
  sessionState: SessionStateMap | undefined,
): void {
  const state = context.get(AgentTraceContextKey);
  if (state === undefined) return;
  const calls = new Set(getBlockingWorkflowToolRuns(sessionState).map((run) => run.callId));
  const actionAnchors = Object.fromEntries(
    Object.entries(state.actionAnchors).filter(
      ([key, action]) =>
        action.sessionId !== sessionId ||
        state.actions[key] !== undefined ||
        calls.has(action.callId),
    ),
  );
  context.set(AgentTraceContextKey, { ...state, actionAnchors });
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

/** Reads the active turn context straight out of a serialized Workflow context. */
export function readTurnTraceContext(
  serializedContext: Readonly<Record<string, unknown>>,
  sessionId: string,
  turnId: string,
): SessionTraceContext | undefined {
  const raw = serializedContext[AgentTraceContextKey.name];
  if (raw === undefined) return undefined;
  const state = deserializeAgentTraceContextState(raw);
  const turn = state.turns[turnKey(sessionId, turnId)];
  return turn === undefined
    ? undefined
    : withTraceDecision(serializedContext, turn.context, state.sessions[sessionId]?.decision);
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
  const key = actionIdempotencyKey(sessionId, turnId, callId);
  const action = state.actions[key] ?? state.actionAnchors[key];
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

  setActionAnchor(idempotencyKey: string, value: AgentActionTraceState): void {
    updateState((state) => ({
      ...state,
      actionAnchors: { ...state.actionAnchors, [idempotencyKey]: value },
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
