import type { InitializeResult } from "#compiled/@ai-sdk/mcp/index.js";
import { isObject } from "#shared/guards.js";

/** Namespace prefix for framework-owned MCP session entries in `session.state`. */
export const MCP_SESSION_STATE_PREFIX = "eve.mcp.session";

/**
 * Streamable HTTP session metadata needed to resume an MCP client without
 * sending a second initialize request.
 */
export interface DurableMcpSessionState {
  readonly initializeResult: InitializeResult;
  readonly sessionId: string;
}

/**
 * Per-step, per-connection holder for stateful MCP session metadata.
 */
export interface McpSessionSlot {
  readonly stateKey: string;
  readonly initial?: DurableMcpSessionState;
  current?: DurableMcpSessionState;
  pendingSessionId?: string;
}

/** Map of connection name to live session slot for one step. */
export type McpSessionSlots = ReadonlyMap<string, McpSessionSlot>;

/** A single durable session-state mutation applied by the provider. */
export interface McpSessionUpdate {
  readonly state?: DurableMcpSessionState;
  readonly stateKey: string;
}

export function mcpSessionStateKey(
  connectionName: string,
  principalKey: string | null | undefined,
): string {
  return `${MCP_SESSION_STATE_PREFIX}.${connectionName}.${principalKey ?? "anonymous"}`;
}

export function readMcpSessionState(value: unknown): DurableMcpSessionState | undefined {
  if (!isObject(value) || typeof value.sessionId !== "string") {
    return undefined;
  }
  if (!isInitializeResult(value.initializeResult)) {
    return undefined;
  }
  return {
    initializeResult: value.initializeResult,
    sessionId: value.sessionId,
  };
}

export function collectMcpSessionUpdates(slots: McpSessionSlots): readonly McpSessionUpdate[] {
  const updates: McpSessionUpdate[] = [];
  for (const slot of slots.values()) {
    if (!sameMcpSessionState(slot.initial, slot.current)) {
      updates.push({ state: slot.current, stateKey: slot.stateKey });
    }
  }
  return updates;
}

function sameMcpSessionState(
  left: DurableMcpSessionState | undefined,
  right: DurableMcpSessionState | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.sessionId === right.sessionId &&
    JSON.stringify(left.initializeResult) === JSON.stringify(right.initializeResult)
  );
}

function isInitializeResult(value: unknown): value is InitializeResult {
  if (
    !isObject(value) ||
    typeof value.protocolVersion !== "string" ||
    !isObject(value.capabilities) ||
    !isObject(value.serverInfo)
  ) {
    return false;
  }
  return typeof value.serverInfo.name === "string" && typeof value.serverInfo.version === "string";
}
