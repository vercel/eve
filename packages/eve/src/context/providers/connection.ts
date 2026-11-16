import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { FrameworkContextProvider } from "#context/provider.js";

export { ConnectionRegistryKey } from "#context/providers/connection-key.js";

export const connectionProvider: FrameworkContextProvider<ConnectionRegistry> = {
  key: ConnectionRegistryKey,

  create(ctx, _session) {
    // Dynamic connection definitions install theirs into this registry beside these.
    const connections = ctx.get(SessionAgentKey)?.connections();
    return connections === undefined
      ? undefined
      : { value: new ConnectionRegistryImpl(connections) };
  },

  // Each step builds its own registry, so its clients must close with the
  // step or every step leaks one remote MCP session (#4379).
  dispose: (registry) => registry.dispose(),
};
