import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest, CompiledChannelRoutePlan } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
} from "#protocol/routes.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

export type ApplicationRouteMethod = ChannelRouteMethod | "ALL" | "HEAD" | "OPTIONS";

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
  /** Active channel bindings from the compiled channel route plan. */
  readonly channelRegistrations: readonly ApplicationChannelRouteRegistration[];
  /** Channel and preflight routes mounted by the application host. */
  readonly channelRoutes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
  /** Every registration in Nitro registration order. */
  readonly routes: readonly ApplicationRouteRegistration[];
}

interface ApplicationRouteRegistryHost {
  readonly compileResult: {
    readonly manifest: Pick<CompiledAgentManifest, "channelRoutes">;
  };
}

/**
 * Projects the compiled channel route plan plus the closed host inventory
 * into the registrations the Nitro host mounts. The plan is authoritative:
 * every ordinary route and generated preflight comes from it verbatim, and
 * no second merge, override, or silent drop happens here.
 */
export function createApplicationRouteRegistryFromInput(input: {
  readonly channelRoutePlan: CompiledChannelRoutePlan;
  readonly development?: boolean;
}): ApplicationRouteRegistry {
  const routes: ApplicationRouteRegistration[] = [];
  const channelRoutes: Array<ApplicationChannelPreflightRoute | ApplicationChannelRoute> = [];
  const channelRegistrations: ApplicationChannelRouteRegistration[] = [];

  for (const route of input.channelRoutePlan.effective) {
    const channelRoute: ApplicationChannelRoute = {
      cors: route.cors,
      kind: "channel",
      method: route.method,
      path: route.urlPath,
    };
    routes.push(channelRoute);
    channelRoutes.push(channelRoute);
    channelRegistrations.push({
      cors: route.cors,
      method: route.method,
      route: route.urlPath,
    });
  }

  for (const preflight of input.channelRoutePlan.preflight) {
    const preflightRoute: ApplicationChannelPreflightRoute = {
      cors: preflight.cors,
      kind: "channel-preflight",
      method: "OPTIONS",
      path: preflight.urlPath,
    };
    routes.push(preflightRoute);
    channelRoutes.push(preflightRoute);
  }

  if (input.development === true) {
    routes.push({
      kind: "development-artifacts",
      method: "GET",
      path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
    });
    routes.push({
      kind: "development-schedule",
      method: "POST",
      path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
    });
  }

  routes.push({
    kind: "workflow",
    method: "ALL",
    path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
  });

  return { channelRegistrations, channelRoutes, routes };
}

export function createApplicationRouteRegistry(
  preparedHost: ApplicationRouteRegistryHost,
  options: { readonly development?: boolean } = {},
): ApplicationRouteRegistry {
  return createApplicationRouteRegistryFromInput({
    channelRoutePlan: preparedHost.compileResult.manifest.channelRoutes,
    development: options.development,
  });
}

export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return createApplicationRouteRegistry(preparedHost).channelRegistrations;
}
