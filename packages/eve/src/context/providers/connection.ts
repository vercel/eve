import { ContextKey } from "#context/key.js";
import { AuthKey } from "#context/keys.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import {
  mcpSessionStateKey,
  readMcpSessionState,
  type McpSessionSlot,
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

    const auth = ctx.get(AuthKey);
    const principalKey =
      auth !== undefined && auth !== null ? `${auth.issuer}:${auth.principalId}` : undefined;

    const slots = new Map<string, McpSessionSlot>();
    for (const connection of connections) {
      if (connection.protocol !== "mcp" || connection.session?.mode !== "stateful") {
        continue;
      }
      const stateKey = mcpSessionStateKey(connection.connectionName, principalKey);
      const persisted = readMcpSessionState(session.state?.[stateKey]);
      slots.set(connection.connectionName, {
        current: persisted,
        initial: persisted,
        stateKey,
      });
    }

    return { value: new ConnectionRegistryImpl(connections, slots) };
  },

  commit(registry, session) {
    const updates = registry.collectMcpSessionUpdates();
    if (updates.length === 0) return session;

    const state: Record<string, unknown> = { ...session.state };
    for (const update of updates) {
      if (update.state === undefined) {
        delete state[update.stateKey];
      } else {
        state[update.stateKey] = update.state;
      }
    }
    return { ...session, state };
  },
};
