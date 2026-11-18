import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

const PRODUCTION_ENVIRONMENT = "production";
const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

export function resolveVercelProductionCallbackBaseUrl(): string | null {
  if (
    process.env.VERCEL_ENV === PRODUCTION_ENVIRONMENT &&
    process.env.VERCEL_PROJECT_PRODUCTION_URL
  ) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return null;
}

export function resolveWorkflowCallbackBaseUrl(metadataUrl: string): string {
  const configuredLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV]?.trim();
  const localBaseUrl = configuredLocalBaseUrl ? configuredLocalBaseUrl : undefined;
  const resolved = resolveVercelProductionCallbackBaseUrl() ?? localBaseUrl ?? metadataUrl;
  const baseUrl = resolved.replace(/\/$/, "");
  const publicRoutePrefix = normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV]);
  return publicRoutePrefix === undefined ? baseUrl : `${baseUrl}${publicRoutePrefix}`;
}

export function createBrowserCallbackUrl(baseUrl: string, callbackPath: string): string {
  const callback = new URL(callbackPath, "http://eve.local");
  const url = new URL(baseUrl);
  url.pathname = joinEveRoutePath(url.pathname, callback.pathname);
  url.search = callback.search;
  return url.toString();
}

export function createWorkflowCallbackUrl(baseUrl: string, callbackPath: string): string {
  return createBrowserCallbackUrl(baseUrl, callbackPath);
}
