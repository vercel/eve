import { ContextKey } from "#context/key.js";
import { AuthKey } from "#context/keys.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import {
  mcpSessionStateKey,
  type McpSessionSlot,
  type McpSessionSlots,
} from "#runtime/connections/mcp-session-store.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";

/**
 * Context key for the per-session connection registry.
 *
 * Created as a derived key (no codec) because the registry holds live
 * client instances that cannot be serialized across step boundaries.
 * The `connectionProvider` reconstructs it each step.
 */
export const ConnectionRegistryKey = new ContextKey<ConnectionRegistry>("eve.connectionRegistry");

export const connectionProvider: FrameworkContextProvider<ConnectionRegistry> = {
  key: ConnectionRegistryKey,

  create(ctx, session) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const connections = node.agent?.connections;
    if (!connections || connections.length === 0) return undefined;

    const principalId = ctx.get(AuthKey)?.principalId;

    const slots: Map<string, McpSessionSlot> = new Map();
    for (const connection of connections) {
      if (connection.protocol === "mcp" && connection.session === "stateful") {
        const stateKey = mcpSessionStateKey(connection.connectionName, principalId);
        const persisted = session.state?.[stateKey];
        const initialId = typeof persisted === "string" ? persisted : undefined;
        slots.set(connection.connectionName, { stateKey, initialId, sessionId: initialId });
      }
    }

    const sessionSlots: McpSessionSlots = slots;
    return { value: new ConnectionRegistryImpl(connections, sessionSlots) };
  },

  commit(registry, session) {
    const updates = registry.collectMcpSessionUpdates();
    if (updates.length === 0) return session;

    const newState: Record<string, unknown> = { ...session.state };
    for (const { stateKey, sessionId } of updates) {
      newState[stateKey] = sessionId;
    }
    return { ...session, state: newState };
  },
};
