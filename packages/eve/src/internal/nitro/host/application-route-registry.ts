import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest, CompiledChannelRoutePlan } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  getHostRouteRegistrations,
  type HostRouteRegistrationForMount,
} from "#protocol/host-route-inventory.js";

export interface ApplicationChannelRouteRegistration {
  readonly method: ChannelRouteMethod;
  readonly route: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

export interface ApplicationChannelRoute {
  readonly kind: "channel";
  readonly method: ChannelRouteMethod;
  readonly path: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

export interface ApplicationChannelPreflightRoute {
  readonly kind: "channel-preflight";
  readonly method: "OPTIONS";
  readonly path: string;
  readonly cors: NormalizedChannelCorsOptions;
}

type ApplicationHostRouteRegistration =
  | HostRouteRegistrationForMount<"development-application">
  | HostRouteRegistrationForMount<"production-application">;

type ApplicationHostRouteForRegistration<Registration> =
  Registration extends ApplicationHostRouteRegistration
    ? {
        readonly hostRouteId: Registration["id"];
        readonly kind: "host";
        readonly method: Registration["method"];
        readonly path: Registration["pathPattern"];
      }
    : never;

export type ApplicationHostRoute =
  ApplicationHostRouteForRegistration<ApplicationHostRouteRegistration>;

export type ApplicationRouteRegistration =
  | ApplicationChannelPreflightRoute
  | ApplicationChannelRoute
  | ApplicationHostRoute;

export interface ApplicationRouteRegistry {
  readonly routes: readonly ApplicationRouteRegistration[];
}

interface ApplicationRouteRegistryHost {
  readonly compileResult: {
    readonly manifest: Pick<CompiledAgentManifest, "channelRoutes">;
  };
}

/** Projects the compiler-owned route plan and appends the closed host inventory. */
export function createApplicationRouteRegistryFromInput(input: {
  readonly channelRoutes: CompiledChannelRoutePlan;
  readonly development?: boolean;
}): ApplicationRouteRegistry {
  const routes: ApplicationRouteRegistration[] = [
    ...input.channelRoutes.effective.map((route): ApplicationChannelRoute => ({
      cors: route.cors,
      kind: "channel",
      method: route.method,
      path: route.urlPath,
    })),
    ...input.channelRoutes.preflight.map((route): ApplicationChannelPreflightRoute => ({
      cors: route.cors,
      kind: "channel-preflight",
      method: "OPTIONS",
      path: route.pathPattern,
    })),
  ];

  const hostMount =
    input.development === true ? "development-application" : "production-application";
  routes.push(...getHostRouteRegistrations(hostMount).map(toApplicationHostRoute));

  return { routes };
}

function toApplicationHostRoute(
  registration: ApplicationHostRouteRegistration,
): ApplicationHostRoute {
  return {
    hostRouteId: registration.id,
    kind: "host",
    method: registration.method,
    path: registration.pathPattern,
  } as ApplicationHostRoute;
}

export function createApplicationRouteRegistry(
  preparedHost: ApplicationRouteRegistryHost,
  options: { readonly development?: boolean } = {},
): ApplicationRouteRegistry {
  return createApplicationRouteRegistryFromInput({
    channelRoutes: preparedHost.compileResult.manifest.channelRoutes,
    development: options.development,
  });
}

export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return preparedHost.compileResult.manifest.channelRoutes.effective.map((route) => ({
    cors: route.cors,
    method: route.method,
    route: route.urlPath,
  }));
}
