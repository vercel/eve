import type { SpanContext } from "@opentelemetry/api";

import type { SessionTraceContext } from "#channel/types.js";
import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ContextAccessor } from "#context/key.js";
import { SessionTraceSeedKey, type SessionTraceSeed } from "#context/keys.js";
import type {
  AgentActionTraceState,
  AgentTraceStateStore,
  AgentTraceValues,
} from "#tracing/eve/agent-trace-state.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import { snapshotReference } from "#tracing/lib/index.js";
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
  type AgentTraceContextState,
  type AgentTraceEntry,
  traceStateKey,
  traceStateValue,
} from "#tracing/eve/agent-trace-context-codec.js";

const AgentTraceContextKey = new ContextKey<AgentTraceContextState>(AGENT_TRACE_CONTEXT_KEY, {
  codec: {
    deserialize: deserializeAgentTraceContextState,
    serialize: (state) => state,
  },
});

export function readPendingToolSnapshot(): unknown {
  return contextStorage.getStore()?.get(AgentTraceContextKey)?.pendingTools;
}
export function currentTraceSessionId(runId: string): string | undefined {
  return traceStateValue(contextStorage.getStore()?.get(AgentTraceContextKey), "session", runId)
    ?.traceSessionId;
}
export function writePendingToolSnapshot(snapshot: unknown): void {
  const context = contextStorage.getStore();
  if (context === undefined) return;
  const state = context.get(AgentTraceContextKey) ?? emptyAgentTraceContextState();
  context.set(AgentTraceContextKey, { ...state, pendingTools: snapshot });
}

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
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(
      ([, entry]) =>
        entry.kind !== "action" ||
        entry.value.sessionId !== sessionId ||
        entry.active ||
        calls.has(entry.value.callId),
    ),
  );
  context.set(AgentTraceContextKey, { ...state, entries });
}

export function readSessionTraceDecision(
  context: ContextAccessor,
  sessionId: string,
): InstrumentationDecision | undefined {
  return traceStateValue(context.get(AgentTraceContextKey), "session", sessionId)?.decision;
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
  const turn = traceStateValue(state, "turn", JSON.stringify([sessionId, turnId]));
  return turn === undefined
    ? undefined
    : withTraceDecision(
        serializedContext,
        turn.context,
        traceStateValue(state, "session", sessionId)?.decision,
      );
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
  const action = traceStateValue(state, "action", key);
  if (action === undefined) return undefined;
  const reference = snapshotReference(action.snapshot);
  if (reference === undefined) return undefined;
  return withTraceDecision(
    serializedContext,
    { ...reference, isRemote: false },
    traceStateValue(state, "session", action.sessionId)?.decision,
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
  get<K extends keyof AgentTraceValues>(kind: K, key: string): AgentTraceValues[K] | undefined {
    const entry = contextStorage.getStore()?.get(AgentTraceContextKey)?.entries[
      traceStateKey(kind === "anchor" ? "action" : kind, key)
    ];
    if (
      entry === undefined ||
      (entry.kind === "action" && !(kind === "anchor" ? entry.retained : entry.active))
    )
      return undefined;
    return entry.value as AgentTraceValues[K];
  }
  set<K extends keyof AgentTraceValues>(kind: K, key: string, value: AgentTraceValues[K]): void {
    updateState((state) => {
      const id = traceStateKey(kind === "anchor" ? "action" : kind, key);
      const previous = state.entries[id];
      const entry: AgentTraceEntry =
        kind === "action" || kind === "anchor"
          ? {
              kind: "action",
              value: value as AgentActionTraceState,
              active: kind === "action" || (previous?.kind === "action" && previous.active),
              retained: kind === "anchor" || (previous?.kind === "action" && previous.retained),
            }
          : ({ kind, value } as AgentTraceEntry);
      return { ...state, entries: { ...state.entries, [id]: entry } };
    });
  }
  delete(kind: keyof AgentTraceValues, key: string): void {
    updateState((state) => {
      const id = traceStateKey(kind === "anchor" ? "action" : kind, key);
      const entry = state.entries[id];
      const entries = { ...state.entries };
      if (entry?.kind === "action" && kind === "action" && entry.retained)
        entries[id] = { ...entry, active: false };
      else if (entry?.kind === "action" && kind === "anchor" && entry.active)
        entries[id] = { ...entry, retained: false };
      else delete entries[id];
      return { ...state, entries };
    });
  }
  update<K extends keyof AgentTraceValues>(
    kind: K,
    key: string,
    update: (value: AgentTraceValues[K]) => AgentTraceValues[K],
  ): void {
    const value = this.get(kind, key);
    if (value !== undefined) this.set(kind, key, update(value));
  }
  entries<K extends keyof AgentTraceValues>(kind: K): [string, AgentTraceValues[K]][] {
    return Object.entries(
      contextStorage.getStore()?.get(AgentTraceContextKey)?.entries ?? {},
    ).flatMap(([key, entry]) =>
      entry.kind === (kind === "anchor" ? "action" : kind) &&
      (entry.kind !== "action" || (kind === "anchor" ? entry.retained : entry.active))
        ? [
            [JSON.parse(key)[1] as string, entry.value as AgentTraceValues[K]] as [
              string,
              AgentTraceValues[K],
            ],
          ]
        : [],
    );
  }
}

function updateState(update: (state: AgentTraceContextState) => AgentTraceContextState): void {
  loadContext().set(AgentTraceContextKey, (state) =>
    update(state ?? emptyAgentTraceContextState()),
  );
}
