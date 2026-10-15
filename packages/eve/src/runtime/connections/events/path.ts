import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export function connectionEventRoute(connectionName: string): string {
  return `${EVE_ROUTE_PREFIX}/hooks/${encodeURIComponent(connectionName)}`;
}
export function connectionEventDestination(connectionName: string): string {
  return joinEveRoutePath(
    normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV]) ?? "",
    connectionEventRoute(connectionName),
  );
}

/** The handler run's hook: the receiver resumes it by the binding id Connect echoes in context. */
export function connectionEventHookToken(bindingId: string): string {
  return `eve:connection-event:${bindingId}`;
}

/** Where a handler run's predecessor sends its final state; one per generation of a watch. */
export function connectionEventHandoverToken(bindingId: string, generation: number): string {
  return `${connectionEventHookToken(bindingId)}:handover:${generation}`;
}
