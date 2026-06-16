/**
 * Per-step cache of resolved connection authorization tokens.
 *
 * Keyed by `(connectionName, principalKey)` so two users on the same
 * session never share a user-scoped token. Stored as a virtual
 * context value and wiped between workflow steps, so bearer tokens
 * are never serialized into the durable step payload. Cross-step
 * reuse is delegated to the upstream authorization provider (for
 * example Connect's server-side cache), which owns the refresh grant.
 *
 * TODO(eve): once a server-derivable session key is available, promote
 * this back to durable context via an AEAD codec so cross-step reuse
 * is possible without exposing plaintext bearers in the WDK payload.
 */

import type { AlsContext, ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { TokenResult } from "#runtime/connections/types.js";

/**
 * Inner map of `principalKey` → {@link TokenResult} for one connection.
 */
type PrincipalTokenCache = Readonly<Record<string, TokenResult>>;

/**
 * Virtual context key mapping connection name to a per-principal
 * {@link TokenResult} cache.
 *
 * The principal sub-key is produced by
 * {@link principalKey} so identical string keys (for example
 * `"user:${issuer}:${id}"`) collide only when the resolved principal
 * genuinely matches.
 */
export const ConnectionAuthorizationTokensKey = new ContextKey<
  Readonly<Record<string, PrincipalTokenCache>>
>("eve.connectionAuthorizationTokens");

/**
 * Returns the cached {@link TokenResult} for
 * `(connectionName, principalKey)` when the entry is still valid
 * (not expired). Expired entries are treated as a cache miss so
 * callers re-run the authorization flow.
 */
export function readCachedToken(
  ctx: AlsContext,
  connectionName: string,
  principalKey: string,
): TokenResult | undefined {
  const entry = ctx.get(ConnectionAuthorizationTokensKey)?.[connectionName]?.[principalKey];
  if (entry === undefined) return undefined;
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry;
}

/**
 * Persists a freshly resolved {@link TokenResult} on the cache under
 * `(connectionName, principalKey)`. Existing entries for other
 * principals on the same connection are left in place.
 *
 * Writes to the virtual context slot so the bearer is never serialized
 * into the durable step payload. See the module docblock.
 */
export function writeCachedToken(
  ctx: AlsContext,
  connectionName: string,
  principalKey: string,
  token: TokenResult,
): void {
  const existing = ctx.get(ConnectionAuthorizationTokensKey) ?? {};
  const perConnection = existing[connectionName] ?? {};
  asContainer(ctx).setVirtualContext(ConnectionAuthorizationTokensKey, {
    ...existing,
    [connectionName]: { ...perConnection, [principalKey]: token },
  });
}

/**
 * Drops the cached {@link TokenResult} for `(connectionName, principalKey)`,
 * if present. Used when the remote server rejects an already-resolved
 * bearer (HTTP 401) so the subsequent re-authorization attempt does not
 * re-read the stale token from the per-step cache. No-op when nothing is
 * cached for the principal.
 */
export function evictCachedToken(
  ctx: AlsContext,
  connectionName: string,
  principalKey: string,
): void {
  const existing = ctx.get(ConnectionAuthorizationTokensKey);
  const perConnection = existing?.[connectionName];
  if (existing === undefined || perConnection === undefined) return;
  if (perConnection[principalKey] === undefined) return;

  const { [principalKey]: _removed, ...rest } = perConnection;
  asContainer(ctx).setVirtualContext(ConnectionAuthorizationTokensKey, {
    ...existing,
    [connectionName]: rest,
  });
}

/**
 * Runtime installs `ContextContainer` as the concrete `AlsContext`;
 * we reach through the interface here because `setVirtualContext` is
 * intentionally runtime-only and not exposed on the public
 * {@link AlsContext} surface.
 */
function asContainer(ctx: AlsContext): ContextContainer {
  return ctx as ContextContainer;
}
