import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
} from "#protocol/routes.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

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

export type ApplicationRouteRegistration =
  | ApplicationChannelPreflightRoute
  | ApplicationChannelRoute
  | {
      readonly kind: "development-artifacts";
      readonly method: "GET";
      readonly path: string;
    }
  | {
      readonly kind: "development-schedule";
      readonly method: "POST";
      readonly path: string;
    }
  | {
      readonly kind: "workflow";
      readonly method: "ALL";
      readonly path: string;
    };

export interface ApplicationRouteRegistry {
  readonly channelRegistrations: readonly ApplicationChannelRouteRegistration[];
  readonly channelRoutes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
  readonly routes: readonly ApplicationRouteRegistration[];
}

interface ApplicationRouteRegistryHost {
  readonly compileResult: {
    readonly manifest: Pick<CompiledAgentManifest, "channelRoutes">;
  };
}

/** Projects the compiler-owned route plan into Nitro registration records. */
export function createApplicationRouteRegistry(
  preparedHost: ApplicationRouteRegistryHost,
  options: { readonly development?: boolean } = {},
): ApplicationRouteRegistry {
  const plan = preparedHost.compileResult.manifest.channelRoutes;
  const channelRegistrations = plan.effective.map((route) => ({
    cors: route.cors,
    method: route.method,
    route: route.urlPath,
  }));
  const channelRoutes: Array<ApplicationChannelPreflightRoute | ApplicationChannelRoute> = [
    ...plan.effective.map((route): ApplicationChannelRoute => ({
      cors: route.cors,
      kind: "channel",
      method: route.method,
      path: route.urlPath,
    })),
    ...plan.preflight.map((route): ApplicationChannelPreflightRoute => ({
      cors: route.cors,
      kind: "channel-preflight",
      method: "OPTIONS",
      path: route.urlPath,
    })),
  ];
  const routes: ApplicationRouteRegistration[] = [...channelRoutes];

  if (options.development === true) {
    routes.push(
      {
        kind: "development-artifacts",
        method: "GET",
        path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
      },
      {
        kind: "development-schedule",
        method: "POST",
        path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
      },
    );
  }

  routes.push({ kind: "workflow", method: "ALL", path: EVE_WORKFLOW_FLOW_ROUTE_PATH });
  return { channelRegistrations, channelRoutes, routes };
}

export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return createApplicationRouteRegistry(preparedHost).channelRegistrations;
}
