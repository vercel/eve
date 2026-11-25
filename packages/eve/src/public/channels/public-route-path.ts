import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

/**
 * Turns a channel route path (such as `"/eve/v1/board"`) into the public path
 * callers reach on this deployment, applying `EVE_PUBLIC_ROUTE_PREFIX` (or
 * `prefix`, when passed) and named-agent mount mapping.
 */
export function publicRoutePath(route: string, prefix?: string): string {
  const normalizedPrefix = normalizePublicRoutePrefix(
    prefix ?? process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV],
  );
  return joinEveRoutePath(normalizedPrefix ?? "", route);
}
