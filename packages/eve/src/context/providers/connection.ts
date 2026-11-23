import { SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mcpClientPool } from "#runtime/connections/mcp-client-pool.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { FrameworkContextProvider } from "#context/provider.js";

export { ConnectionRegistryKey } from "#context/providers/connection-key.js";

export const connectionProvider: FrameworkContextProvider<ConnectionRegistry> = {
  key: ConnectionRegistryKey,

  create(ctx, _session) {
    const connections = ctx.get(SessionAgentKey)?.connections();
    if (connections === undefined) return undefined;
    const session = ctx.get(SessionKey);
    const sharing =
      session === undefined
        ? undefined
        : {
            pool: mcpClientPool,
            scope: JSON.stringify([session.sessionId, session.turn.sequence, session.auth]),
          };
    return { value: new ConnectionRegistryImpl(connections, sharing) };
  },

  dispose: (registry) => registry.dispose(),
};
