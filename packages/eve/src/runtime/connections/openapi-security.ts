import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { deref, isArray } from "#runtime/connections/openapi-schema.js";
import { isObject } from "#shared/guards.js";

/**
 * How the connection's resolved credential is placed on a request,
 * derived from the operation's effective `security` requirement and the
 * document's `securitySchemes` (OpenAPI 3.x) or `securityDefinitions`
 * (Swagger 2.0).
 *
 * - `bearer` — `Authorization: Bearer <token>` (the default; also covers
 *   `oauth2` / `openIdConnect`, whose access tokens are bearer tokens).
 * - `basic` — `Authorization: Basic <token>` (the author supplies the
 *   base64-encoded `user:pass` as the token).
 * - `apiKey` — the token is placed in the named header, query param, or
 *   cookie instead of `Authorization`.
 */
export type SecurityPlacement =
  | { readonly kind: "bearer" }
  | { readonly kind: "basic" }
  | { readonly kind: "apiKey"; readonly in: "header" | "query" | "cookie"; readonly name: string };

/**
 * Resolves how an operation's credential should be placed, from its
 * effective `security` requirement (operation-level overrides the
 * document-level default) and the document's `securitySchemes`.
 *
 * Returns `undefined` when no requirement applies, in which case the
 * default `Authorization: Bearer` behavior is used. The first recognized
 * scheme in the first requirement object wins.
 */
export function resolveSecurity(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): SecurityPlacement | undefined {
  const requirement = isArray(operation.security)
    ? operation.security
    : isArray(document.security)
      ? document.security
      : undefined;
  if (requirement === undefined || requirement.length === 0) {
    return undefined;
  }
  const schemes = getSecuritySchemes(document);
  if (schemes === undefined) {
    return undefined;
  }
  for (const entry of requirement) {
    if (!isObject(entry)) {
      continue;
    }
    const schemeName = Object.keys(entry)[0];
    if (schemeName === undefined) {
      continue;
    }
    const rawScheme = schemes[schemeName];
    const scheme = isObject(rawScheme) ? deref(document, rawScheme) : undefined;
    if (!isObject(scheme)) {
      continue;
    }
    const placement = mapSecurityScheme(scheme);
    if (placement !== undefined) {
      return placement;
    }
  }
  return undefined;
}

function getSecuritySchemes(
  document: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const components = isObject(document.components) ? document.components : undefined;
  if (components !== undefined && isObject(components.securitySchemes)) {
    return components.securitySchemes;
  }
  return isObject(document.securityDefinitions) ? document.securityDefinitions : undefined;
}

/** Maps one OpenAPI security scheme object to a {@link SecurityPlacement}. */
function mapSecurityScheme(scheme: Record<string, unknown>): SecurityPlacement | undefined {
  if (scheme.type === "apiKey") {
    const location = scheme.in;
    if (
      (location === "header" || location === "query" || location === "cookie") &&
      typeof scheme.name === "string" &&
      scheme.name.length > 0
    ) {
      return { kind: "apiKey", in: location, name: scheme.name };
    }
    return undefined;
  }
  if (scheme.type === "http") {
    const httpScheme = typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : "";
    return httpScheme === "basic" ? { kind: "basic" } : { kind: "bearer" };
  }
  if (scheme.type === "basic") {
    return { kind: "basic" };
  }
  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return { kind: "bearer" };
  }
  return undefined;
}

/**
 * Reshapes the resolved credential according to the operation's
 * {@link SecurityPlacement}. The credential is resolved once by
 * `resolveHeaders` as `Authorization: Bearer <token>`; this moves
 * it where the scheme says (api-key header/query/cookie) or rewrites the
 * `Authorization` scheme (basic). A `bearer` placement, a missing
 * placement, or a connection without `authorization` is a no-op.
 */
export function applySecurity(
  placement: SecurityPlacement | undefined,
  connection: ResolvedConnectionDefinition,
  headers: Record<string, string>,
  query: URLSearchParams,
  cookies: string[],
): void {
  if (placement === undefined || connection.authorization === undefined) {
    return;
  }
  const token = extractBearerToken(headers);
  if (token === undefined) {
    return;
  }
  if (placement.kind === "bearer") {
    return;
  }
  if (placement.kind === "basic") {
    headers.Authorization = `Basic ${token}`;
    return;
  }
  delete headers.Authorization;
  if (placement.in === "header") {
    headers[placement.name] = token;
  } else if (placement.in === "query") {
    query.set(placement.name, token);
  } else {
    cookies.push(`${placement.name}=${token}`);
  }
}

/** Extracts the token from an `Authorization: Bearer <token>` header, if present. */
function extractBearerToken(headers: Record<string, string>): string | undefined {
  const value = headers.Authorization ?? headers.authorization;
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
