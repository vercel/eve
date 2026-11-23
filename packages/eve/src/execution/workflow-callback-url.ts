import { builtInPlatform } from "#platform/context.js";
import type { Entities } from "#platform/entities.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import { readEnv } from "#runtime-env/env.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

export function resolveVercelProductionCallbackBaseUrl(platform: Entities): string | null {
  const { deployment } = platform;
  const productionHost = deployment.productionHost();
  if (deployment.environment() === "production" && productionHost !== undefined) {
    return `https://${productionHost}`;
  }
  return null;
}

export function resolveWorkflowCallbackBaseUrl(
  metadataUrl: string,
  platform: Entities = builtInPlatform(),
): string {
  const configuredLocalBaseUrl = readEnv(WORKFLOW_LOCAL_BASE_URL_ENV)?.trim();
  const localBaseUrl = configuredLocalBaseUrl ? configuredLocalBaseUrl : undefined;
  const resolved = resolveVercelProductionCallbackBaseUrl(platform) ?? localBaseUrl ?? metadataUrl;
  const baseUrl = resolved.replace(/\/$/, "");
  const publicRoutePrefix = normalizePublicRoutePrefix(readEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV));
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
