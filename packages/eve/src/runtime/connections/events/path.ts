import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import { readEnv } from "#platform/env.js";

export function connectionEventRoute(connectionName: string): string {
  return `${EVE_ROUTE_PREFIX}/hooks/${encodeURIComponent(connectionName)}`;
}
export function connectionEventDestination(connectionName: string): string {
  return joinEveRoutePath(
    normalizePublicRoutePrefix(readEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV)) ?? "",
    connectionEventRoute(connectionName),
  );
}

/** The watch run's hook: the receiver finds it by the binding id Connect echoes in context. */
export function connectionEventHookToken(bindingId: string): string {
  return `eve:connection-event:${bindingId}`;
}
