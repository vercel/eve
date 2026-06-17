/**
 * Scope-parameterized authorization flow shared by MCP connections and
 * authored tools that declare `auth`.
 *
 * A *scope* is the stable identifier the per-step token cache and the
 * framework-owned callback URL are keyed by — a connection name for an
 * MCP connection, a tool name for tool-hosted auth. Everything else
 * (principal resolution, the park/resume webhook dance, the loop guard)
 * is identical across both, so it lives here once instead of being
 * duplicated per caller.
 */

import { type AlsContext, contextStorage, loadContext } from "#context/container.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import {
  type AuthorizationSignal,
  getAuthorizationResult,
  getHookUrl,
  requestAuthorization,
} from "#harness/authorization.js";
import type { JsonValue } from "#public/types/json.js";
import {
  evictCachedToken,
  readCachedToken,
  writeCachedToken,
} from "#runtime/connections/authorization-tokens.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import {
  type AuthorizationDefinition,
  type ConnectionAuthorizationContext,
  type InteractiveAuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";

/**
 * Everything the scoped authorization helpers need to drive one
 * authorization strategy: the cache/callback {@link scope}, the
 * authored {@link AuthorizationDefinition}, and the per-scope
 * {@link ConnectionAuthorizationContext} handed to every callback.
 */
export interface ScopedAuthorization {
  readonly scope: string;
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly connection: ConnectionAuthorizationContext;
}

/**
 * Resolves a bearer token for one scope, consulting the per-step token
 * cache before invoking the authored `getToken`.
 *
 * The cache is keyed by `(scope, principalKey(principal))` so concurrent
 * users on one session never alias onto each other's bearer. Outside a
 * runtime scope the cache is unavailable, but `getToken` still runs with
 * a framework-resolved principal so ad-hoc `"app"`-scoped use keeps
 * working; `"user"`-scoped strategies without a context fail fast inside
 * {@link resolveConnectionPrincipal}.
 *
 * `getToken` may throw {@link ConnectionAuthorizationRequiredError};
 * callers catch it and drive {@link startScopedAuthorization}.
 */
export async function resolveScopedToken(input: ScopedAuthorization): Promise<TokenResult> {
  const { scope, authorization, connection } = input;

  // Reading `contextStorage.getStore()` directly keeps this the only
  // place that tolerates a missing context; authored code uses
  // `loadContext()` so misuse fails loudly.
  const ctx = contextStorage.getStore();
  const principal = resolveConnectionPrincipal(scope, authorization, ctx);

  if (ctx === undefined) {
    return await authorization.getToken({ connection, principal });
  }

  const key = principalKey(principal);
  const cached = readCachedToken(ctx, scope, key);
  if (cached !== undefined) return cached;

  const result = await authorization.getToken({ connection, principal });
  writeCachedToken(ctx, scope, key, result);
  return result;
}

/**
 * Best-effort removal of a rejected bearer for one scope's resolved
 * principal, across every cache layer.
 *
 * Called when an already-resolved bearer is rejected (a downstream
 * `401`, or an explicit `requireAuth()` after a failed call) so the
 * re-authorization attempt does not re-read the stale token. Drops two
 * layers: eve's per-step cache, and — via the strategy's optional
 * {@link AuthorizationDefinition.evict} hook — any cache the strategy
 * itself owns (e.g. the `@vercel/connect` in-process token cache). The
 * single shared eviction path here means both authored tools and MCP
 * connections cascade identically.
 *
 * No-op outside a runtime scope or when the principal cannot be
 * resolved; a resolution failure here must never mask the underlying
 * authorization error that triggered the eviction.
 */
export async function evictScopedToken(input: ScopedAuthorization): Promise<void> {
  const { scope, authorization, connection } = input;
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  let principal;
  try {
    principal = resolveConnectionPrincipal(scope, authorization, ctx);
    evictCachedToken(ctx, scope, principalKey(principal));
  } catch {
    // Eviction is best-effort; without a principal we can drop neither
    // cache layer, so bail rather than mask the authorization error.
    return;
  }
  try {
    await authorization.evict?.({ connection, principal });
  } catch {
    // The strategy's own cache eviction is best-effort too.
  }
}

/**
 * Completes an authorization whose callback arrived this turn, caching
 * the freshly minted token under the scope.
 *
 * Returns `true` when a token was minted. Callers use the boolean as a
 * loop guard: a scope authorized this turn that still reports `Required`
 * on the immediately following call has a token the server itself
 * rejected, so it must fail terminally rather than re-challenge forever.
 *
 * No-op (returns `false`) when the strategy is not interactive or no
 * callback arrived for the scope.
 */
export async function completeScopedAuthorization(input: ScopedAuthorization): Promise<boolean> {
  const { scope, authorization, connection } = input;
  if (!supportsInteractiveAuthorization(authorization)) return false;

  const result = getAuthorizationResult(scope);
  if (result === undefined) return false;

  const interactive = authorization as InteractiveAuthorizationDefinition<JsonValue>;
  const ctx: AlsContext = loadContext();
  const principal = resolveConnectionPrincipal(scope, interactive, ctx);
  const token = await interactive.completeAuthorization({
    callbackUrl: result.hookUrl,
    connection,
    principal,
    resume: result.resume,
    callback: result.callback,
  });
  writeCachedToken(ctx, scope, principalKey(principal), token);
  return true;
}

/**
 * Starts an interactive authorization for one scope and returns the
 * {@link AuthorizationSignal} a tool returns to park the turn.
 *
 * Returns `undefined` when the strategy is not interactive or no
 * callback URL can be minted (for example outside a deployment), so
 * callers can fall through to rethrowing the original `Required` error.
 */
export async function startScopedAuthorization(
  input: ScopedAuthorization,
): Promise<AuthorizationSignal | undefined> {
  const { scope, authorization, connection } = input;
  if (!supportsInteractiveAuthorization(authorization)) return undefined;

  const hookUrl = getHookUrl(scope);
  if (hookUrl === undefined) return undefined;

  const interactive = authorization as InteractiveAuthorizationDefinition<JsonValue>;
  const principal = resolveConnectionPrincipal(scope, interactive);
  const { challenge, resume } = await interactive.startAuthorization({
    callbackUrl: hookUrl,
    connection,
    principal,
  });
  return requestAuthorization([
    {
      challenge: stampChallengeDisplayName(challenge, authorization),
      hookUrl,
      name: scope,
      resume,
    },
  ]);
}

/**
 * Resolves the user-facing `displayName` onto a challenge before it is
 * surfaced on `authorization.required`.
 *
 * The agent author's static definition-level value wins over the
 * strategy-stamped one: an author writing
 * `auth: { ...connect("x"), displayName: "Y" }` is the most explicit
 * intent, while strategies provide defaults. Returns the input challenge
 * unchanged when the resolved value does not differ.
 */
export function stampChallengeDisplayName(
  challenge: ConnectionAuthorizationChallenge,
  authorization: Readonly<AuthorizationDefinition>,
): ConnectionAuthorizationChallenge {
  const displayName = authorization.displayName ?? challenge.displayName;
  if (displayName === challenge.displayName) return challenge;
  return { ...challenge, displayName };
}
