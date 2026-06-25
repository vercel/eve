import { buildCallbackContext } from "#context/build-callback-context.js";
import { type AlsContext, ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { AuthorizationDefinition } from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";

type ResolvedAuthorization = Readonly<AuthorizationDefinition> | undefined;
type AuthorizationResolverCache = Map<ResolvedConnectionDefinition, Promise<ResolvedAuthorization>>;

const ConnectionAuthorizationResolversKey = new ContextKey<AuthorizationResolverCache>(
  "eve.connectionAuthorizationResolvers",
);

/**
 * Resolves and validates the auth provider for the active connection call.
 * Dynamic providers are cached for the execution step so token resolution,
 * interactive OAuth, and eviction all use the same provider instance.
 */
export async function resolveConnectionAuthorization(
  connection: ResolvedConnectionDefinition,
  ctx?: SessionContext,
): Promise<ResolvedAuthorization> {
  const authorization = connection.authorization;
  if (authorization === undefined || typeof authorization !== "function") {
    return authorization;
  }

  const activeContext = contextStorage.getStore();
  if (activeContext === undefined) {
    return await resolveDynamicAuthorization(connection, ctx);
  }

  const cache = getResolverCache(activeContext);
  let pending = cache.get(connection);
  if (pending === undefined) {
    pending = resolveDynamicAuthorization(connection, ctx);
    cache.set(connection, pending);
  }
  return await pending;
}

async function resolveDynamicAuthorization(
  connection: ResolvedConnectionDefinition,
  ctx?: SessionContext,
): Promise<ResolvedAuthorization> {
  const authorization = connection.authorization;
  if (typeof authorization !== "function") {
    return authorization;
  }
  const provider = await authorization(ctx ?? buildCallbackContext());
  return normalizeAuthorizationSpec(
    provider,
    `Connection "${connection.connectionName}" auth resolver:`,
  );
}

function getResolverCache(ctx: AlsContext): AuthorizationResolverCache {
  const existing = ctx.get(ConnectionAuthorizationResolversKey);
  if (existing !== undefined) return existing;

  const cache: AuthorizationResolverCache = new Map();
  (ctx as ContextContainer).setVirtualContext(ConnectionAuthorizationResolversKey, cache);
  return cache;
}
