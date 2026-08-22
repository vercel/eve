import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
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
      readonly kind: "health";
      readonly method: "GET" | "HEAD";
      readonly path: string;
    }
  | {
      readonly kind: "home";
      readonly method: "GET";
      readonly path: string;
    }
  | {
      readonly kind: "workflow";
      readonly method: "ALL";
      readonly path: string;
    };

export interface ApplicationRouteRegistry {
  /** Active channel bindings after framework override and route deduplication. */
  readonly channelRegistrations: readonly ApplicationChannelRouteRegistration[];
  /** Channel and preflight routes accepted by the application-wide registry. */
  readonly channelRoutes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
  /** Globally deduplicated method/path bindings in Nitro registration order. */
  readonly routes: readonly ApplicationRouteRegistration[];
}

interface ApplicationRouteRegistryHost {
  readonly compileResult: {
    readonly manifest: Pick<CompiledAgentManifest, "channels">;
  };
}

interface ApplicationChannelManifestEntry {
  readonly kind: "channel";
  readonly name: string;
  readonly method: ChannelRouteMethod;
  readonly urlPath: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

interface CreateApplicationRouteRegistryInput {
  readonly development?: boolean;
  readonly manifestChannels: readonly ApplicationChannelManifestEntry[];
}

const PACKAGE_ROUTES: readonly ApplicationRouteRegistration[] = [
  { kind: "home", method: "GET", path: "/" },
  { kind: "health", method: "GET", path: EVE_HEALTH_ROUTE_PATH },
  { kind: "health", method: "HEAD", path: EVE_HEALTH_ROUTE_PATH },
];

function createMethodPathKey(input: {
  readonly method: ApplicationRouteMethod;
  readonly path: string;
}): string {
  return `${input.method} ${input.path}`;
}

/** Compiles route identity, precedence, and deduplication without importing Nitro. */
export function createApplicationRouteRegistryFromInput(
  input: CreateApplicationRouteRegistryInput,
): ApplicationRouteRegistry {
  const routes: ApplicationRouteRegistration[] = [];
  const channelRoutes: Array<ApplicationChannelPreflightRoute | ApplicationChannelRoute> = [];
  const channelRegistrations: ApplicationChannelRouteRegistration[] = [];
  const methodPaths = new Set<string>();

  const addRoute = (route: ApplicationRouteRegistration): boolean => {
    const key = createMethodPathKey(route);
    if (methodPaths.has(key)) {
      return false;
    }
    methodPaths.add(key);
    routes.push(route);
    return true;
  };

  for (const route of PACKAGE_ROUTES) {
    addRoute(route);
  }

  const preflightPaths = new Set<string>();
  for (const channel of input.manifestChannels) {
    const channelRoute: ApplicationChannelRoute = {
      cors: channel.cors,
      kind: "channel",
      method: channel.method,
      path: channel.urlPath,
    };
    if (!addRoute(channelRoute)) {
      continue;
    }
    channelRegistrations.push({
      cors: channel.cors,
      method: channel.method,
      route: channel.urlPath,
    });
    channelRoutes.push(channelRoute);

    if (
      channel.method !== "WEBSOCKET" &&
      channel.cors !== undefined &&
      !preflightPaths.has(channel.urlPath)
    ) {
      preflightPaths.add(channel.urlPath);
      const preflightRoute: ApplicationChannelPreflightRoute = {
        cors: channel.cors,
        kind: "channel-preflight",
        method: "OPTIONS",
        path: channel.urlPath,
      };
      if (addRoute(preflightRoute)) {
        channelRoutes.push(preflightRoute);
      }
    }
  }

  if (input.development === true) {
    addRoute({
      kind: "development-artifacts",
      method: "GET",
      path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
    });
    addRoute({
      kind: "development-schedule",
      method: "POST",
      path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
    });
  }

  addRoute({
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
    development: options.development,
    manifestChannels: preparedHost.compileResult.manifest.channels,
  });
}

export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return createApplicationRouteRegistry(preparedHost).channelRegistrations;
}
