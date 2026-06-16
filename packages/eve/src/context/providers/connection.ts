import { ContextKey } from "#context/key.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
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

  create(ctx, _session) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const connections = node.agent?.connections;
    if (!connections || connections.length === 0) return undefined;

    return { value: new ConnectionRegistryImpl(connections) };
  },
};
