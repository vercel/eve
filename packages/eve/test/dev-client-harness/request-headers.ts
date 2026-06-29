import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { isLocalDevelopmentServerUrl } from "#services/dev-client/local-host.js";
import { VERCEL_PROTECTION_BYPASS_HEADER } from "#services/dev-client/request-headers.js";

export { VERCEL_PROTECTION_BYPASS_HEADER } from "#services/dev-client/request-headers.js";
export { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

const EVE_ROUTE_PREFIX_WITH_SEPARATOR = `${EVE_ROUTE_PREFIX}/`;
export const VERCEL_OIDC_TOKEN_HEADER = "x-vercel-oidc-token";

/** Header values accepted by the test-only development client harness. */
export type DevelopmentRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string>;

type MutableDevelopmentRequestHeaders = Headers | Array<[string, string]> | Record<string, string>;

/**
 * Test-harness credential behavior for live Vercel fixtures. Production
 * development clients require an authorized `DevelopmentCredentialGate`.
 */
export async function createDevelopmentRequestHeadersAsync(input: {
  readonly headers?: DevelopmentRequestHeaders;
  readonly resourceUrl: URL;
}): Promise<Headers> {
  const headers = new Headers(resolveHeadersInit(input.headers));
  if (!isEveRouteUrl(input.resourceUrl)) return headers;

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypassSecret) headers.set(VERCEL_PROTECTION_BYPASS_HEADER, bypassSecret);
  if (isLocalDevelopmentServerUrl(input.resourceUrl.toString())) return headers;

  const forwardedToken = headers.get(VERCEL_OIDC_TOKEN_HEADER)?.trim();
  const oidcToken = forwardedToken || (await resolveTestOidcToken());
  if (oidcToken.length === 0) return headers;

  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${oidcToken}`);
  headers.set(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER, oidcToken);
  return headers;
}

async function resolveTestOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();
    if (token.length > 0) return token;
  } catch {
    // Fall through to the fixture environment.
  }
  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}

function isEveRouteUrl(url: URL): boolean {
  return (
    url.pathname.endsWith(EVE_ROUTE_PREFIX) ||
    url.pathname.includes(EVE_ROUTE_PREFIX_WITH_SEPARATOR)
  );
}

function isHeaderEntries(
  headers: DevelopmentRequestHeaders,
): headers is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(headers);
}

function resolveHeadersInit(
  headers: DevelopmentRequestHeaders | undefined,
): MutableDevelopmentRequestHeaders | undefined {
  if (headers === undefined || headers instanceof Headers) return headers;
  if (isHeaderEntries(headers)) {
    return headers.map(([key, value]): [string, string] => [key, value]);
  }
  return headers;
}
