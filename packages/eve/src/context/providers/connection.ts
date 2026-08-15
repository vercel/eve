import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";

export { ConnectionRegistryKey } from "#context/providers/connection-key.js";

export const connectionProvider: FrameworkContextProvider<ConnectionRegistry> = {
  key: ConnectionRegistryKey,

  create(ctx, _session) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const connections = node.agent?.connections;
    if (!connections || connections.length === 0) return undefined;

    return { value: new ConnectionRegistryImpl(connections) };
  },
};
