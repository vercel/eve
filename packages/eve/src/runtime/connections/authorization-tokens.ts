import type { AlsContext, ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { TokenResult } from "#shared/connection-types.js";

type PrincipalTokenCache = Readonly<Record<string, TokenResult>>;

export const ConnectionAuthorizationTokensKey = new ContextKey<
  Readonly<Record<string, PrincipalTokenCache>>
>("eve.connectionAuthorizationTokens");

export function readCachedToken(
  ctx: AlsContext,
  authorizationScope: string,
  principalKey: string,
): TokenResult | undefined {
  const entry = ctx.get(ConnectionAuthorizationTokensKey)?.[authorizationScope]?.[principalKey];
  if (entry === undefined) return undefined;
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry;
}

export function writeCachedToken(
  ctx: AlsContext,
  authorizationScope: string,
  principalKey: string,
  token: TokenResult,
): void {
  const existing = ctx.get(ConnectionAuthorizationTokensKey) ?? {};
  const perScope = existing[authorizationScope] ?? {};
  asContainer(ctx).setVirtualContext(ConnectionAuthorizationTokensKey, {
    ...existing,
    [authorizationScope]: { ...perScope, [principalKey]: token },
  });
}

export function evictCachedToken(
  ctx: AlsContext,
  authorizationScope: string,
  principalKey: string,
): void {
  const existing = ctx.get(ConnectionAuthorizationTokensKey);
  const perScope = existing?.[authorizationScope];
  if (existing === undefined || perScope === undefined) return;
  if (perScope[principalKey] === undefined) return;

  const { [principalKey]: _removed, ...rest } = perScope;
  asContainer(ctx).setVirtualContext(ConnectionAuthorizationTokensKey, {
    ...existing,
    [authorizationScope]: rest,
  });
}

function asContainer(ctx: AlsContext): ContextContainer {
  return ctx as ContextContainer;
}
