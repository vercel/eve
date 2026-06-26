/**
 * Durable-state helpers for stateful MCP connections.
 *
 * A connection authored with `session: "stateful"` keeps its
 * server-assigned `Mcp-Session-Id` in `session.state` so it survives eve
 * step boundaries. This module owns the key derivation and the per-step
 * "slot" the runtime mutates while a step runs; the `connectionProvider`
 * seeds slots on `create` and drains them on `commit`.
 */

/** Namespace prefix for all persisted MCP session keys in `session.state`. */
export const MCP_SESSION_STATE_PREFIX = "eve.mcp.session";

/**
 * Builds the `session.state` key for a connection's persisted MCP session id.
 *
 * Keyed by connection name and authenticated principal so two principals
 * sharing one connection in the same eve session never reuse each other's
 * server-side session. `session.state` is itself per-eve-session, so the
 * `"anonymous"` fallback for an unauthenticated caller is safe.
 */
export function mcpSessionStateKey(
  connectionName: string,
  principalId: string | null | undefined,
): string {
  return `${MCP_SESSION_STATE_PREFIX}.${connectionName}.${principalId ?? "anonymous"}`;
}

/**
 * Per-step, per-connection holder for a stateful MCP session id.
 *
 * `initialId` is the id seeded from durable state at step start (read-only
 * for the step). `sessionId` is the live id the transport injects and the
 * server may replace; the provider compares the two on `commit` to decide
 * what to persist.
 */
export interface McpSessionSlot {
  readonly stateKey: string;
  readonly initialId?: string;
  sessionId?: string;
}

/** Map of connection name → live session slot for one step. */
export type McpSessionSlots = ReadonlyMap<string, McpSessionSlot>;

/** A single durable write the provider applies on `commit`. */
export interface McpSessionUpdate {
  readonly stateKey: string;
  readonly sessionId: string;
}

/**
 * Returns the durable writes for slots whose live `sessionId` was set and
 * differs from the seeded `initialId` (new session or server-driven
 * re-initialization). Unchanged and never-connected slots produce nothing.
 */
export function collectMcpSessionUpdates(slots: McpSessionSlots): readonly McpSessionUpdate[] {
  const updates: McpSessionUpdate[] = [];
  for (const slot of slots.values()) {
    if (slot.sessionId !== undefined && slot.sessionId !== slot.initialId) {
      updates.push({ stateKey: slot.stateKey, sessionId: slot.sessionId });
    }
  }
  return updates;
}
