import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { SessionKey, type Session } from "#context/keys.js";
import { getSessionConnectionRegistry } from "#runtime/connections/registry-cache.js";

export { ConnectionRegistryKey } from "#context/providers/connection-key.js";

export const connectionProvider: FrameworkContextProvider<ConnectionRegistry> = {
  key: ConnectionRegistryKey,

  create(ctx, session) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const connections = node.agent?.connections;
    if (!connections || connections.length === 0) return undefined;

    return {
      value: getSessionConnectionRegistry({
        connections,
        scopeKey: getConnectionScopeKey(ctx.require(SessionKey)),
        sessionId: session.sessionId,
      }),
    };
  },
};

function getConnectionScopeKey(session: Session): string {
  return JSON.stringify({
    auth: session.auth,
    parent: session.parent,
    sessionId: session.sessionId,
    turnSequence: session.turn.sequence,
  });
}
