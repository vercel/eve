/**
 * Structural validation for authored connection auth definitions. Returns
 * `undefined` on success or a context-free error fragment for the caller to
 * prefix.
 */

import type {
  AuthorizationDefinition,
  InteractiveAuthorizationDefinition,
  NonInteractiveAuthorizationDefinition,
} from "#runtime/connections/types.js";

/**
 * Validates that authored `auth` conforms to the connection auth contract.
 *
 * Returns `undefined` on success; otherwise a descriptive message
 * fragment starting with `The "<fieldName>"...` that the caller is expected
 * to prefix with its own context.
 */
export function validateAuthorizationSpec(
  authorization: unknown,
  fieldName = "auth",
): string | undefined {
  if (authorization === null || typeof authorization !== "object") {
    return `The "${fieldName}" field must be an object with a "getToken" method.`;
  }

  const auth = authorization as Record<string, unknown>;

  if (typeof auth.getToken !== "function") {
    return `The "${fieldName}.getToken" field must be a function returning Promise<{ token }>.`;
  }

  const hasStart = auth.startAuthorization !== undefined;
  const hasComplete = auth.completeAuthorization !== undefined;

  if (!hasStart && !hasComplete && auth.principalType !== undefined) {
    if (auth.principalType !== "app" && auth.principalType !== "user") {
      return `The "${fieldName}.principalType" field must be "app" or "user".`;
    }
  }

  if (hasStart !== hasComplete) {
    return `The "${fieldName}" field must provide either both "startAuthorization" and "completeAuthorization" (interactive OAuth) or neither (getToken-only). Got only "${hasStart ? "startAuthorization" : "completeAuthorization"}".`;
  }

  if (hasStart && typeof auth.startAuthorization !== "function") {
    return `The "${fieldName}.startAuthorization" field must be a function when provided.`;
  }

  if (hasComplete && typeof auth.completeAuthorization !== "function") {
    return `The "${fieldName}.completeAuthorization" field must be a function when provided.`;
  }

  if (hasStart && auth.principalType !== "user") {
    return `Interactive authorization (startAuthorization + completeAuthorization) is restricted to "principalType": "user" in v1. App-level credentials must use a getToken-only definition.`;
  }

  if (
    auth.displayName !== undefined &&
    (typeof auth.displayName !== "string" || auth.displayName.length === 0)
  ) {
    return `The "${fieldName}.displayName" field must be a non-empty string when provided.`;
  }

  return undefined;
}

/**
 * Validates and normalizes an authored auth definition into the runtime shape.
 *
 * `getToken`-only auth defaults to `principalType: "app"` so static tokens and
 * custom bearer-token fetchers do not need extra boilerplate.
 */
export function normalizeAuthorizationSpec(
  authorization: unknown,
  prefix: string,
  fieldName = "auth",
): AuthorizationDefinition {
  const message = validateAuthorizationSpec(authorization, fieldName);
  if (message !== undefined) {
    throw new Error(`${prefix} ${message}`);
  }

  const auth = authorization as Record<string, unknown>;
  const vercelConnect = extractVercelConnectMarker(auth.vercelConnect);
  const displayName = auth.displayName as string | undefined;
  const evict =
    typeof auth.evict === "function" ? (auth.evict as AuthorizationDefinition["evict"]) : undefined;
  if (auth.startAuthorization !== undefined && auth.completeAuthorization !== undefined) {
    let interactive: InteractiveAuthorizationDefinition = {
      completeAuthorization:
        auth.completeAuthorization as InteractiveAuthorizationDefinition["completeAuthorization"],
      getToken: auth.getToken as InteractiveAuthorizationDefinition["getToken"],
      principalType: "user",
      startAuthorization:
        auth.startAuthorization as InteractiveAuthorizationDefinition["startAuthorization"],
    };
    if (vercelConnect !== undefined) interactive = { ...interactive, vercelConnect };
    if (displayName !== undefined) interactive = { ...interactive, displayName };
    if (evict !== undefined) interactive = { ...interactive, evict };
    return interactive;
  }

  let nonInteractive: NonInteractiveAuthorizationDefinition = {
    getToken: auth.getToken as NonInteractiveAuthorizationDefinition["getToken"],
    principalType: (auth.principalType ??
      "app") as NonInteractiveAuthorizationDefinition["principalType"],
  };
  if (vercelConnect !== undefined) nonInteractive = { ...nonInteractive, vercelConnect };
  if (displayName !== undefined) nonInteractive = { ...nonInteractive, displayName };
  if (evict !== undefined) nonInteractive = { ...nonInteractive, evict };
  return nonInteractive;
}

/**
 * Reads the optional `vercelConnect: { connector: string }` marker
 * attached by `@vercel/connect/eve`'s `connect()` helper. Returns the
 * parsed marker when present and well-formed, otherwise `undefined`.
 *
 * The runtime uses the marker for Connect-specific authorization behavior,
 * while downstream tooling can attribute the auth back to a Vercel Connect
 * connector without inspecting `getToken`'s closure state. Validation is
 * lenient (a malformed marker is dropped, not thrown) so a misbehaving auth
 * provider can't fail an otherwise-valid connection.
 */
function extractVercelConnectMarker(value: unknown): { readonly connector: string } | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const connector = (value as { connector?: unknown }).connector;
  if (typeof connector !== "string" || connector.length === 0) {
    return undefined;
  }
  return { connector };
}
