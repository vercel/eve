import type { McpSessionSlot } from "#runtime/connections/mcp-session-store.js";

/**
 * The MCP session header (lowercase; `Headers` is case-insensitive). See
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
 */
export const MCP_SESSION_ID_HEADER = "mcp-session-id";

/**
 * Wraps `globalThis.fetch` so a stateful MCP connection injects and captures
 * its `Mcp-Session-Id`.
 *
 * On each request it adds the slot's current `sessionId` as the
 * `Mcp-Session-Id` header (unless the caller already set one), and on each
 * response it records any `Mcp-Session-Id` the server returned back onto the
 * slot. The slot is the single source of truth for the id, so clearing it on
 * a `404` (see {@link McpConnectionClient}) makes the next `initialize`
 * negotiate a fresh session.
 */
export function createSessionCapturingFetch(slot: McpSessionSlot): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (slot.sessionId !== undefined && !headers.has(MCP_SESSION_ID_HEADER)) {
      headers.set(MCP_SESSION_ID_HEADER, slot.sessionId);
    }

    const response = await globalThis.fetch(input, { ...init, headers });

    const assigned = response.headers.get(MCP_SESSION_ID_HEADER);
    if (assigned !== null && assigned !== slot.sessionId) {
      slot.sessionId = assigned;
    }
    return response;
  };
}
