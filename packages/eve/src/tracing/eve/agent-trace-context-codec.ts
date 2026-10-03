import type {
  AgentActionTraceState,
  AgentSessionTraceState,
  AgentTurnTraceState,
} from "#tracing/eve/agent-trace-state.js";
import { parseJsonObject } from "#shared/json.js";

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
  readonly pendingTools?: unknown;
  readonly entries: Readonly<Record<string, AgentTraceEntry>>;
}
export type AgentTraceEntry =
  | { kind: "session"; value: AgentSessionTraceState }
  | { kind: "turn"; value: AgentTurnTraceState }
  | { kind: "action"; value: AgentActionTraceState; active: boolean; retained: boolean };
export function traceStateKey(kind: AgentTraceEntry["kind"], ...ids: string[]): string {
  return JSON.stringify([kind, ...ids]);
}
export function traceStateValue<K extends AgentTraceEntry["kind"]>(
  state: AgentTraceContextState | undefined,
  kind: K,
  ...ids: string[]
): Extract<AgentTraceEntry, { kind: K }>["value"] | undefined {
  return state?.entries[traceStateKey(kind, ...ids)]?.value as never;
}

export function emptyAgentTraceContextState(): AgentTraceContextState {
  return { entries: {} };
}

export function deserializeAgentTraceContextState(data: unknown): AgentTraceContextState {
  try {
    const state = parseJsonObject(data);
    if (typeof state.entries !== "object" || state.entries === null || Array.isArray(state.entries))
      return emptyAgentTraceContextState();
    const entries: Record<string, AgentTraceEntry> = {};
    for (const [key, value] of Object.entries(state.entries)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as import("#shared/json.js").JsonObject;
      if (record.kind !== "session" && record.kind !== "turn" && record.kind !== "action") continue;
      if (record.value === null || typeof record.value !== "object" || Array.isArray(record.value))
        continue;
      const entry: object = value;
      entries[key] = entry as AgentTraceEntry;
    }
    return { pendingTools: state.pendingTools, entries };
  } catch {
    return emptyAgentTraceContextState();
  }
}
