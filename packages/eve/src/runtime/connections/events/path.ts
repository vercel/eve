import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export const CONNECTION_EVENT_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/hooks/:connectionName`;

export function connectionEventRoute(connectionName: string): string {
  return `${EVE_ROUTE_PREFIX}/hooks/${encodeURIComponent(connectionName)}`;
}
export function connectionEventDestination(connectionName: string): string {
  return joinEveRoutePath(
    normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV]) ?? "",
    connectionEventRoute(connectionName),
  );
}

/** The watch run's hook: the receiver finds it by the binding id Connect echoes in context. */
export function connectionEventHookToken(bindingId: string): string {
  return `eve:connection-event:${bindingId}`;
}
