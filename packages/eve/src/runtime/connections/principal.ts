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
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
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
 * - `{ type: "user", id }` → `"user:${id}"`. This is the native
 *   Vercel Connect user projection.
 */
export function principalKey(principal: ConnectionPrincipal): string {
  if (principal.type === "app") {
    return "app";
  }
  if (principal.issuer === undefined) {
    return `user:${principal.id}`;
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
      message: buildUserPrincipalRequiredMessage(connectionName, authorization, ctx, current),
      reason: "principal_required",
      retryable: false,
    });
  }

  if (authorization.vercelConnect !== undefined && isVercelDevelopmentUser(current)) {
    return {
      attributes: current.attributes,
      id: current.subject ?? current.principalId,
      type: "user",
    };
  }

  return {
    attributes: current.attributes,
    id: current.principalId,
    issuer: current.issuer ?? current.authenticator,
    type: "user",
  };
}

function isVercelDevelopmentUser(current: SessionAuthContext): boolean {
  return (
    current.authenticator === "oidc" &&
    current.issuer?.startsWith("https://oidc.vercel.com/") === true &&
    current.attributes.environment === "development" &&
    current.subject === current.attributes.user_id
  );
}

function buildUserPrincipalRequiredMessage(
  connectionName: string,
  authorization: AuthorizationDefinition,
  ctx: AlsContext | undefined,
  current: SessionAuthContext | null | undefined,
): string {
  let detail: string;
  if (ctx === undefined) {
    detail = "it was invoked outside an eve context, so no authenticated user can be resolved.";
  } else if (current === undefined || current === null) {
    detail = "the active session has no authenticated user.";
  } else if (authorization.vercelConnect !== undefined && current.authenticator === "local-dev") {
    detail =
      "the local request fell back to local development access instead of authenticating a Vercel user. " +
      "Ensure this directory is linked and the Vercel CLI can mint a Vercel OIDC token, then retry.";
  } else {
    detail = `the active session is scoped to "${current.principalType}", not an authenticated user.`;
  }

  return (
    `Connection "${connectionName}" is user-scoped, but ${detail} ` +
    `User-scoped connections require route auth that resolves an authenticated user. ` +
    `If this connection should use credentials shared by the agent instead, configure it as an app-scoped connection.`
  );
}
