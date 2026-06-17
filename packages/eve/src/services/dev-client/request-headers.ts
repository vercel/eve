import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EVE_ROUTE_PREFIX_WITH_SEPARATOR = `${EVE_ROUTE_PREFIX}/`;

/**
 * Hostnames the dev client treats as "local" for auth purposes. When the
 * target server is one of these, the dev client skips the Vercel OIDC
 * bearer entirely — the framework's default channel auth chain is
 * `[localDev(), vercelOidc()]`, and `localDev()` accepts off Vercel
 * infrastructure, so attaching a bearer would be wasted work and noise
 * in the request inspector.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/**
 * Returns whether `serverUrl` targets one of the recognized local
 * development hostnames. Invalid URLs return `false` so callers can
 * always proceed as if the target is remote.
 */
export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  try {
    return isLocalEveServerUrl(new URL(serverUrl));
  } catch {
    return false;
  }
}

/**
 * Resolves a Vercel OIDC token for the development client.
 *
 * Tries the `@vercel/oidc` SDK first (refreshes a freshly-issued token
 * when the CLI is linked to a Vercel project), then falls back to the
 * `VERCEL_OIDC_TOKEN` environment variable. Returns an empty string
 * when no token is available so callers can proceed without auth.
 */
export async function resolveDevelopmentOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();

    if (token.length > 0) {
      return token;
    }
  } catch {
    // Fall through to env var.
  }

  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}

/**
 * Vercel header used to bypass preview protection for framework-owned routes
 * during local CLI development. Paired with a Protection Bypass for
 * Automation token issued from Project Settings.
 */
export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * Vercel header used to bypass deployment protection by presenting a
 * trusted OIDC token issued by Vercel for the linked project. When the
 * CLI is `vercel link`-ed (or running inside a Vercel function), the
 * platform mints an OIDC token whose audience and subject match the
 * deployment, and accepts it as proof that the caller is authorized.
 *
 * This is preferred over {@link VERCEL_PROTECTION_BYPASS_HEADER} because
 * it requires no per-project secret — the token is already available via
 * `@vercel/oidc`.
 */
export const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

/**
 * Vercel request header that carries the runtime OIDC token on function
 * invocations.
 */
export const VERCEL_OIDC_TOKEN_HEADER = "x-vercel-oidc-token";

/**
 * Header values accepted by eve's development client helpers.
 */
export type DevelopmentRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string>;

type MutableDevelopmentRequestHeaders = Headers | Array<[string, string]> | Record<string, string>;

function isEveRouteUrl(url: URL): boolean {
  return (
    url.pathname.endsWith(EVE_ROUTE_PREFIX) ||
    url.pathname.includes(EVE_ROUTE_PREFIX_WITH_SEPARATOR)
  );
}

/**
 * Creates request headers for one service-issued development request and
 * opportunistically refreshes a linked local Vercel OIDC token for eve-owned
 * routes when no explicit authorization header is present.
 */
export async function createDevelopmentRequestHeadersAsync(input: {
  headers?: DevelopmentRequestHeaders;
  resourceUrl: URL;
}): Promise<Headers> {
  const headers = createBaseDevelopmentRequestHeaders(input);
  const oidcToken = await resolveEveRouteOidcToken(headers, input.resourceUrl);

  if (oidcToken !== null) {
    attachEveRouteOidcHeaders(headers, oidcToken);
  }

  return headers;
}

function createBaseDevelopmentRequestHeaders(input: {
  headers?: DevelopmentRequestHeaders;
  resourceUrl: URL;
}): Headers {
  const headers = new Headers(resolveDevelopmentHeadersInit(input.headers));
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

  if (bypassSecret && isEveRouteUrl(input.resourceUrl)) {
    headers.set(VERCEL_PROTECTION_BYPASS_HEADER, bypassSecret);
  }

  return headers;
}

/**
 * Sets the authorization bearer and the trusted OIDC IDP bypass header
 * from a single resolved OIDC token. Authorization is left untouched if
 * the caller already set it explicitly; the bypass header is always
 * attached so deployment protection accepts the request even when the
 * caller picked their own bearer scheme (e.g. Basic auth on a preview).
 */
function attachEveRouteOidcHeaders(headers: Headers, oidcToken: string): void {
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${oidcToken}`);
  }
  headers.set(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER, oidcToken);
}

/**
 * Resolves an OIDC token for an eve-owned request, asking
 * `@vercel/oidc` for a freshly-issued token when the CLI is linked to a
 * Vercel project. Falls back to the forwarded runtime header or the
 * `VERCEL_OIDC_TOKEN` environment variable.
 */
async function resolveEveRouteOidcToken(
  headers: Headers,
  resourceUrl: URL,
): Promise<string | null> {
  if (!shouldResolveEveRouteOidcToken(resourceUrl)) {
    return null;
  }

  const requestToken = headers.get(VERCEL_OIDC_TOKEN_HEADER)?.trim();

  if (requestToken) {
    return requestToken;
  }

  return await resolveLocalDevelopmentOidcToken();
}

/**
 * Returns `true` when an eve-route request should attempt to attach a
 * Vercel OIDC token. Local dev servers do not need (and cannot validate)
 * the token, so this returns `false` for them.
 */
function shouldResolveEveRouteOidcToken(resourceUrl: URL): boolean {
  if (!isEveRouteUrl(resourceUrl)) {
    return false;
  }

  // The framework's default HTTP channel auth chain is
  // `[localDev(), vercelOidc()]` (see runtime/framework-channels/index.ts),
  // and `localDev()` accepts off Vercel infrastructure — so attaching a
  // bearer or bypass token to a localhost request is wasted work and
  // noise in the request inspector.
  if (isLocalEveServerUrl(resourceUrl)) {
    return false;
  }

  return true;
}

async function resolveLocalDevelopmentOidcToken(): Promise<string | null> {
  const token = await resolveDevelopmentOidcToken();
  return token.length > 0 ? token : null;
}

function resolveDevelopmentHeadersInit(
  headers?: DevelopmentRequestHeaders,
): MutableDevelopmentRequestHeaders | undefined {
  if (headers === undefined) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers;
  }

  if (Array.isArray(headers)) {
    return headers.map(([key, value]): [string, string] => [key, value]);
  }

  return headers as Record<string, string>;
}

/**
 * Resolves the per-request custom headers used by the development client
 * when constructing requests against a configured server URL.
 *
 * - {@link VERCEL_PROTECTION_BYPASS_HEADER} is attached when
 *   `VERCEL_AUTOMATION_BYPASS_SECRET` is set.
 * - {@link VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER} is attached when a Vercel
 *   OIDC token is available locally (either via `vercel link` +
 *   `@vercel/oidc` or via the `VERCEL_OIDC_TOKEN` environment variable).
 *   This lets the CLI bypass Vercel Deployment Protection without the user
 *   creating a project-scoped Bypass for Automation token first.
 *
 * Both headers are sent when both sources are available; the platform
 * accepts whichever it can validate.
 *
 * Local dev servers skip the OIDC token entirely — the framework's
 * default channel auth chain is `[localDev(), vercelOidc()]`, and
 * `localDev()` accepts off Vercel infrastructure, so attaching the
 * bypass token would be wasted work.
 */
export async function resolveDevelopmentClientHeaders(input: {
  readonly serverUrl: string;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

  if (bypassSecret) {
    headers[VERCEL_PROTECTION_BYPASS_HEADER] = bypassSecret;
  }

  if (!isLocalDevelopmentServerUrl(input.serverUrl)) {
    const oidcToken = await resolveDevelopmentOidcToken();

    if (oidcToken.length > 0) {
      headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = oidcToken;
    }
  }

  return headers;
}
