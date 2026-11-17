import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { deref, isArray } from "#runtime/connections/openapi-schema.js";
import { isObject } from "#shared/guards.js";

export type SecurityPlacement =
  | { readonly kind: "bearer" }
  | { readonly kind: "basic" }
  | { readonly kind: "apiKey"; readonly in: "header" | "query" | "cookie"; readonly name: string };

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

function extractBearerToken(headers: Record<string, string>): string | undefined {
  const value = headers.Authorization ?? headers.authorization;
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
