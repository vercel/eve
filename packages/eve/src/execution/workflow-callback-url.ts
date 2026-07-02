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
 * Resolves the origin used for framework-owned workflow callbacks.
 *
 * Workflow metadata falls back to port 3000 when its optional local port
 * discovery is unavailable. eve already configures the local world with the
 * active dev-server origin, so prefer that value before the metadata fallback.
 */
export function resolveWorkflowCallbackBaseUrl(metadataUrl: string): string {
  const configuredLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV]?.trim();
  const localBaseUrl = configuredLocalBaseUrl ? configuredLocalBaseUrl : undefined;
  const resolved = resolveVercelProductionCallbackBaseUrl() ?? localBaseUrl ?? metadataUrl;
  return resolved.replace(/\/$/, "");
}

/**
 * Builds a framework-owned callback URL from a resolved callback origin.
 */
export function createWorkflowCallbackUrl(baseUrl: string, callbackPath: string): string {
  const url = new URL(callbackPath, baseUrl);

  // https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypassSecret) {
    url.searchParams.set(VERCEL_PROTECTION_BYPASS_QUERY, bypassSecret);
  }

  return url.toString();
}
