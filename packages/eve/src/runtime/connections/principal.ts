import { type AlsContext, contextStorage } from "#context/container.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { AuthorizationDefinition, ConnectionPrincipal } from "#shared/connection-types.js";
import { platformContext } from "#platform/context.js";

export function principalKey(principal: ConnectionPrincipal): string {
  if (principal.type === "app") {
    return "app";
  }
  return JSON.stringify(["user", principal.issuer ?? null, principal.id]);
}

export function resolveConnectionPrincipal(
  connectionName: string,
  authorization: AuthorizationDefinition,
  ctx: AlsContext | undefined = contextStorage.getStore(),
): ConnectionPrincipal {
  return resolveConnectionPrincipalFromAuth(connectionName, authorization, ctx?.get(AuthKey), ctx);
}

export function resolveConnectionPrincipalFromAuth(
  connectionName: string,
  authorization: AuthorizationDefinition,
  current: SessionAuthContext | null | undefined,
  ctx?: AlsContext,
): ConnectionPrincipal {
  if (authorization.principalType === "app") {
    return { type: "app" };
  }

  if (current === null || current === undefined || current.principalType !== "user") {
    throw new ConnectionAuthorizationFailedError(connectionName, {
      message: buildUserPrincipalRequiredMessage(connectionName, authorization, ctx, current),
      reason: "principal_required",
      retryable: false,
    });
  }

  if (authorization.vercelConnect !== undefined && isPlatformDevelopmentCaller(current)) {
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

export function isPlatformDevelopmentCaller(current: SessionAuthContext): boolean {
  return platformContext().identity.developmentCaller?.(current) ?? false;
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
