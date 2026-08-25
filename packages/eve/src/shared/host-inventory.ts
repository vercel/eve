import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  EVE_ROUTE_PREFIX,
} from "#protocol/routes.js";
import {
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#internal/workflow/development-world-protocol.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

/**
 * Reservation-only pattern for the production schedule/cron platform bridge.
 * The concrete path embeds an unguessable deploy token; the reservation
 * covers its match space so no ordinary channel route can collide with it.
 */
export const EVE_PRODUCTION_CRON_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/cron/:token`;

/**
 * Typed category of one non-source host capability. Host behavior outside
 * ordinary compiled sources is limited to these four categories.
 */
export type EveHostCapability =
  | "workflow-transport"
  | "development-control"
  | "schedule-cron-bridge"
  | "process-readiness";

/**
 * One inventoried host HTTP registration or reservation.
 */
export interface EveHostRouteRegistration {
  readonly capability: EveHostCapability;
  readonly development: boolean;
  readonly method: "ALL" | "GET" | "POST";
  readonly pathPattern: string;
  /** Reservation-only entries never register a handler. */
  readonly reservationOnly?: true;
}

/**
 * The closed native host inventory. The application and development hosts
 * register or reserve only these HTTP entries; every ordinary route comes
 * from the compiled channel route plan. Any new host registration requires
 * an inventory entry and collision coverage.
 *
 * The production process-readiness handshake is a non-HTTP host capability
 * and intentionally has no entry here.
 */
export const EVE_HOST_ROUTE_INVENTORY: readonly EveHostRouteRegistration[] = [
  {
    capability: "workflow-transport",
    development: false,
    method: "ALL",
    pathPattern: EVE_WORKFLOW_FLOW_ROUTE_PATH,
  },
  {
    capability: "development-control",
    development: true,
    method: "GET",
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  },
  {
    capability: "development-control",
    development: true,
    method: "GET",
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  },
  {
    capability: "development-control",
    development: true,
    method: "POST",
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  },
  {
    capability: "development-control",
    development: true,
    method: "POST",
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  },
  {
    capability: "development-control",
    development: true,
    method: "POST",
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  },
  {
    capability: "workflow-transport",
    development: true,
    method: "ALL",
    pathPattern: DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  },
  {
    capability: "workflow-transport",
    development: true,
    method: "ALL",
    pathPattern: DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  },
  {
    capability: "schedule-cron-bridge",
    development: true,
    method: "POST",
    pathPattern: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  },
  {
    capability: "schedule-cron-bridge",
    development: false,
    method: "ALL",
    pathPattern: EVE_PRODUCTION_CRON_ROUTE_PATTERN,
    reservationOnly: true,
  },
];

/**
 * Whether two route path patterns can match the same concrete request path.
 * Pattern identity ignores parameter names; a static segment sits inside a
 * parameter's match space.
 */
export function routePathPatternsOverlap(left: string, right: string): boolean {
  const leftSegments = splitPatternSegments(left);
  const rightSegments = splitPatternSegments(right);
  if (leftSegments.length !== rightSegments.length) {
    return false;
  }
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index]!;
    return isParameterSegment(segment) || isParameterSegment(other) || segment === other;
  });
}

/**
 * Whether two route method selectors intersect. `ALL` intersects every HTTP
 * and WebSocket method; `WEBSOCKET` handshakes arrive as `GET` upgrades.
 */
export function routeMethodsIntersect(left: string, right: string): boolean {
  if (left === "ALL" || right === "ALL") {
    return true;
  }
  return left === right;
}

function splitPatternSegments(pattern: string): string[] {
  return pattern.split("/").filter((segment) => segment.length > 0);
}

function isParameterSegment(segment: string): boolean {
  return (
    segment.startsWith(":") ||
    segment.startsWith("*") ||
    (segment.startsWith("[") && segment.endsWith("]"))
  );
}
