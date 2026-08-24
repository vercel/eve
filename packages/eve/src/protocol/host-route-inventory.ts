import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  EVE_DEV_WORKFLOW_STREAM_ROUTE_PATH,
  EVE_DEV_WORKFLOW_WORLD_ROUTE_PATH,
  EVE_PRODUCTION_CRON_ROUTE_PATTERN,
  EVE_WORKFLOW_FLOW_ROUTE_PATH,
} from "#protocol/routes.js";
import { eveRoutePatternMatchesPath } from "#protocol/route-pattern.js";

export type HostRouteMount =
  | "development-application"
  | "development-control"
  | "production-application";

interface HostRouteDefinitionBase {
  readonly id: string;
  readonly methods: readonly ("ALL" | "GET" | "POST")[];
  readonly mounts: readonly HostRouteMount[];
  readonly pathPattern: string;
}

type HostRouteDefinition = HostRouteDefinitionBase &
  (
    | { readonly reservationOnly?: false }
    | {
        /** The concrete route is registered dynamically, while this pattern reserves its match space. */
        readonly reservationOnly: true;
      }
  );

/** Closed protocol inventory of routes owned by the host rather than an agent source. */
export const HOST_ROUTE_INVENTORY = [
  {
    id: "workflow",
    methods: ["ALL"],
    mounts: ["development-application", "production-application"],
    pathPattern: EVE_WORKFLOW_FLOW_ROUTE_PATH,
  },
  {
    id: "development-artifacts",
    methods: ["GET"],
    mounts: ["development-application", "development-control"],
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  },
  {
    id: "development-artifacts-rebuild",
    methods: ["GET", "POST"],
    mounts: ["development-control"],
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  },
  {
    id: "development-artifacts-suspend",
    methods: ["POST"],
    mounts: ["development-control"],
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  },
  {
    id: "development-artifacts-resume",
    methods: ["POST"],
    mounts: ["development-control"],
    pathPattern: EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  },
  {
    id: "development-workflow-world",
    methods: ["ALL"],
    mounts: ["development-control"],
    pathPattern: EVE_DEV_WORKFLOW_WORLD_ROUTE_PATH,
  },
  {
    id: "development-workflow-stream",
    methods: ["ALL"],
    mounts: ["development-control"],
    pathPattern: EVE_DEV_WORKFLOW_STREAM_ROUTE_PATH,
  },
  {
    id: "development-schedule",
    methods: ["POST"],
    mounts: ["development-application"],
    pathPattern: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  },
  {
    id: "production-cron",
    methods: ["ALL"],
    mounts: ["production-application"],
    pathPattern: EVE_PRODUCTION_CRON_ROUTE_PATTERN,
    reservationOnly: true,
  },
] as const satisfies readonly HostRouteDefinition[];

type HostRoute = (typeof HOST_ROUTE_INVENTORY)[number];

type RegisteredHostRoute<Route extends HostRoute = HostRoute> = Route extends HostRoute
  ? Route extends { readonly reservationOnly: true }
    ? never
    : Route
  : never;

type HostRouteForMount<
  Route extends HostRoute,
  Mount extends HostRouteMount,
> = Route extends HostRoute ? (Mount extends Route["mounts"][number] ? Route : never) : never;

type HostRouteRegistrationForRoute<Route extends HostRoute> = Route extends HostRoute
  ? {
      readonly id: Route["id"];
      readonly method: Route["methods"][number];
      readonly pathPattern: Route["pathPattern"];
    }
  : never;

type HostRouteReservationForRoute<Route extends HostRoute> = Route extends HostRoute
  ? HostRouteRegistrationForRoute<Route> & {
      readonly reservationOnly: Route extends { readonly reservationOnly: true } ? true : false;
    }
  : never;

export type HostRouteId = HostRoute["id"];

export type HostRouteIdForMount<Mount extends HostRouteMount> = HostRouteForMount<
  HostRoute,
  Mount
>["id"];

export type HostRouteRegistration = HostRouteRegistrationForRoute<RegisteredHostRoute>;

export type HostRouteRegistrationForMount<Mount extends HostRouteMount> =
  HostRouteRegistrationForRoute<HostRouteForMount<RegisteredHostRoute, Mount>>;

export type HostRouteReservation = HostRouteReservationForRoute<HostRoute>;

export type HostRouteReservationForMount<Mount extends HostRouteMount> =
  HostRouteReservationForRoute<HostRouteForMount<HostRoute, Mount>>;

export function getHostRouteRegistrations(): readonly HostRouteRegistration[];
export function getHostRouteRegistrations<Mount extends HostRouteMount>(
  mount: Mount,
): readonly HostRouteRegistrationForMount<Mount>[];
export function getHostRouteRegistrations(
  mount?: HostRouteMount,
): readonly HostRouteRegistration[] {
  const definitions: readonly HostRoute[] =
    mount === undefined
      ? HOST_ROUTE_INVENTORY
      : HOST_ROUTE_INVENTORY.filter((route) =>
          (route.mounts as readonly HostRouteMount[]).includes(mount),
        );

  return definitions
    .filter(isRegisteredHostRoute)
    .flatMap((route) => route.methods.map((method) => createHostRouteRegistration(route, method)));
}

export function getHostRouteReservations(): readonly HostRouteReservation[];
export function getHostRouteReservations<Mount extends HostRouteMount>(
  mount: Mount,
): readonly HostRouteReservationForMount<Mount>[];
export function getHostRouteReservations(mount?: HostRouteMount): readonly HostRouteReservation[] {
  const definitions: readonly HostRoute[] =
    mount === undefined
      ? HOST_ROUTE_INVENTORY
      : HOST_ROUTE_INVENTORY.filter((route) =>
          (route.mounts as readonly HostRouteMount[]).includes(mount),
        );

  return definitions.flatMap((route) =>
    route.methods.map((method) => ({
      ...createHostRouteRegistration(route, method),
      reservationOnly: "reservationOnly" in route && route.reservationOnly,
    })),
  ) as readonly HostRouteReservation[];
}

function isRegisteredHostRoute(route: HostRoute): route is RegisteredHostRoute {
  return !("reservationOnly" in route && route.reservationOnly);
}

function createHostRouteRegistration<Route extends HostRoute>(
  route: Route,
  method: Route["methods"][number],
): HostRouteRegistrationForRoute<Route> {
  return {
    id: route.id,
    method,
    pathPattern: route.pathPattern,
  } as HostRouteRegistrationForRoute<Route>;
}

export function matchHostRouteRegistration<Mount extends HostRouteMount>(input: {
  readonly method: string;
  readonly mount: Mount;
  readonly pathname: string;
}): HostRouteRegistrationForMount<Mount> | undefined {
  return getHostRouteRegistrations(input.mount).find(
    (route) =>
      (route.method === "ALL" || route.method === input.method) &&
      eveRoutePatternMatchesPath(route.pathPattern, input.pathname),
  );
}
