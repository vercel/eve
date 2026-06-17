/**
 * Principal resolution for connections.
 *
 * This module is the one place the runtime bridges session-layer
 * vocabulary (`"service" | "user" | "runtime" | "unknown"`) to the
 * connection-layer vocabulary (`"app" | "user"`) that connection
 * authors see. Every runtime call site that needs a
 * {@link ConnectionPrincipal} routes through
 * {@link resolveConnectionPrincipal}, and every cache lookup keyed
 * by principal routes through {@link principalKey}.
 */

import { type AlsContext, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { ConnectionAuthorizationFailedError } from "#public/connections/errors.js";
import type { AuthorizationDefinition, ConnectionPrincipal } from "#runtime/connections/types.js";

/**
 * Stable string key identifying one principal within a connection's
 * per-principal token cache.
 *
 * - `{ type: "app" }` → `"app"`. Shared across all sessions.
 * - `{ type: "user", issuer, id }` → `"user:${issuer}:${id}"`. The
 *   issuer prefix prevents collisions when the same `id` across
 *   identity providers (for example Slack `U123` vs Google `U123`)
 *   would otherwise alias to the same cache slot.
 */
export function principalKey(principal: ConnectionPrincipal): string {
  if (principal.type === "app") {
    return "app";
  }
  return `user:${principal.issuer}:${principal.id}`;
}

/**
 * Resolves the {@link ConnectionPrincipal} for one connection.
 *
 * Single entry point for principal resolution — every runtime
 * call site that needs a {@link ConnectionPrincipal} (wrapped tool
 * execution, `startAuthorization` step, `mcp-client` header
 * resolution) routes through here so the decision tree lives in
 * exactly one place.
 *
 * Resolution order:
 *
 * 1. For `authorization.principalType === "app"`, return
 *    `{ type: "app" }` regardless of the session. App-scoped
 *    connections share one credential across all callers and can
 *    be resolved with or without an active context.
 * 2. For `authorization.principalType === "user"`, project the
 *    current caller's {@link SessionAuthContext} (read directly from
 *    the durable {@link AuthKey} seed) into a user principal. A
 *    missing context, an unauthenticated caller, or a non-`"user"`
 *    current principal all fail fast with
 *    `reason: "principal_required"` — no amount of retrying will
 *    recover a misconfigured route, so the runtime does not treat
 *    it as retryable.
 *
 *    {@link AuthKey} is used instead of the derived `SessionKey`
 *    so resolution works in both `runStep` scopes (where
 *    `sessionProvider` has populated `SessionKey`) and durable
 *    `"use step"` boundaries where only the seed keys survive
 *    context serialization. The two are equivalent inside a step
 *    because `sessionProvider` projects `AuthKey` into
 *    `session.auth.current`.
 *
 * `ctx` defaults to {@link contextStorage.getStore}. Pass it
 * explicitly when the caller already has a context handle (for
 * example inside a durable step that deserialized its own
 * {@link AlsContext}) to avoid a redundant ALS lookup.
 *
 * The caller is responsible for passing a matching
 * {@link AuthorizationDefinition}. This helper does not validate
 * the definition shape beyond reading `principalType`.
 */
export function resolveConnectionPrincipal(
  connectionName: string,
  authorization: AuthorizationDefinition,
  ctx: AlsContext | undefined = contextStorage.getStore(),
): ConnectionPrincipal {
  if (authorization.principalType === "app") {
    return { type: "app" };
  }

  const current = ctx?.get(AuthKey);
  if (current === null || current === undefined || current.principalType !== "user") {
    throw new ConnectionAuthorizationFailedError(connectionName, {
      message:
        ctx === undefined
          ? `Connection "${connectionName}" declares principalType "user" ` +
            `but was invoked outside an eve context, so no user principal can be resolved.`
          : `Connection "${connectionName}" declares principalType "user" ` +
            `but the active session has no authenticated user principal.`,
      reason: "principal_required",
      retryable: false,
    });
  }

  return {
    attributes: current.attributes,
    id: current.principalId,
    issuer: current.issuer ?? current.authenticator,
    type: "user",
  };
}
