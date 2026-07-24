import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

const PRODUCTION_ENVIRONMENT = "production";
const VERCEL_PROTECTION_BYPASS_QUERY = "x-vercel-protection-bypass";
const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

/**
 * Workflow metadata is deployment-specific, so on Vercel it can point at
 * the generated deployment URL. Production callbacks need the stable
 * project production URL instead so other services can post back through
 * the same trusted source configuration users set up for the production
 * agent.
 */
export function resolveVercelProductionCallbackBaseUrl(): string | null {
  // https://vercel.com/docs/environment-variables/system-environment-variables#VERCEL_ENV
  // https://vercel.com/docs/environment-variables/system-environment-variables#VERCEL_PROJECT_PRODUCTION_URL
  if (
    process.env.VERCEL_ENV === PRODUCTION_ENVIRONMENT &&
    process.env.VERCEL_PROJECT_PRODUCTION_URL
  ) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return null;
}

/**
 * Resolves the base URL used for framework-owned workflow callbacks.
 *
 * Workflow metadata falls back to port 3000 when its optional local port
 * discovery is unavailable. eve already configures the local world with the
 * active dev-server origin, so prefer that value before the metadata fallback.
 *
 * When {@link EVE_PUBLIC_ROUTE_PREFIX_ENV} is set (baked into deployed
 * Vercel workflow functions for named multi-agent mounts), the prefix is
 * appended so callbacks built from this base resolve to the agent's public
 * `<prefix>/eve/v1/*` mount instead of the bare `/eve/v1/*` path the origin
 * does not serve.
 */
export function resolveWorkflowCallbackBaseUrl(metadataUrl: string): string {
  const configuredLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV]?.trim();
  const localBaseUrl = configuredLocalBaseUrl ? configuredLocalBaseUrl : undefined;
  const resolved = resolveVercelProductionCallbackBaseUrl() ?? localBaseUrl ?? metadataUrl;
  const baseUrl = resolved.replace(/\/$/, "");
  const publicRoutePrefix = normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV]);
  return publicRoutePrefix === undefined ? baseUrl : `${baseUrl}${publicRoutePrefix}`;
}

/**
 * Builds a framework-owned callback URL from a resolved callback base URL.
 *
 * `callbackPath` is appended to the full base URL rather than resolved
 * against it: the base may carry a public route prefix path, which
 * `new URL(path, base)` would drop for absolute paths.
 */
export function createWorkflowCallbackUrl(baseUrl: string, callbackPath: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${callbackPath}`);

  // https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypassSecret) {
    url.searchParams.set(VERCEL_PROTECTION_BYPASS_QUERY, bypassSecret);
  }

  return url.toString();
}
