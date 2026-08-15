import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
} from "#protocol/routes.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
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

type ApplicationChannelManifestEntry =
  | {
      readonly kind: "channel";
      readonly name: string;
      readonly method: ChannelRouteMethod;
      readonly urlPath: string;
      readonly cors?: NormalizedChannelCorsOptions;
    }
  | {
      readonly kind: "disabled";
      readonly name: string;
    };

interface ApplicationFrameworkChannelDefinition {
  readonly name: string;
  readonly method: ChannelRouteMethod;
  readonly urlPath: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

interface MergeApplicationChannelRoutesInput {
  readonly frameworkChannelNames: ReadonlySet<string>;
  readonly frameworkChannels: readonly ApplicationFrameworkChannelDefinition[];
  readonly manifestChannels: readonly ApplicationChannelManifestEntry[];
}

interface CreateApplicationRouteRegistryInput extends MergeApplicationChannelRoutesInput {
  readonly development?: boolean;
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

/** Applies authored-name overrides before deduplicating framework-first route bindings. */
export function mergeApplicationChannelRouteRegistrations(
  input: MergeApplicationChannelRoutesInput,
): readonly ApplicationChannelRouteRegistration[] {
  const authoredNames = new Set<string>();
  const authoredRoutes: ApplicationChannelRouteRegistration[] = [];
  const disabledNames = new Set<string>();

  for (const entry of input.manifestChannels) {
    if (entry.kind === "disabled") {
      if (!input.frameworkChannelNames.has(entry.name)) {
        throw new Error(
          `agent/channels/${entry.name}.ts exports disableRoute() but "${entry.name}" is not a framework channel. ` +
            `Rename the file to one of: ${[...input.frameworkChannelNames].sort().join(", ")}.`,
        );
      }
      disabledNames.add(entry.name);
      continue;
    }

    authoredNames.add(entry.name);
    authoredRoutes.push({
      cors: entry.cors,
      method: entry.method,
      route: entry.urlPath,
    });
  }

  const activeFrameworkRoutes = input.frameworkChannels
    .filter((channel) => !authoredNames.has(channel.name) && !disabledNames.has(channel.name))
    .map((channel): ApplicationChannelRouteRegistration => ({
      cors: channel.cors,
      method: channel.method,
      route: channel.urlPath,
    }));

  const seen = new Set<string>();
  const merged: ApplicationChannelRouteRegistration[] = [];
  for (const registration of [...activeFrameworkRoutes, ...authoredRoutes]) {
    const key = createMethodPathKey({
      method: registration.method,
      path: registration.route,
    });
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(registration);
    }
  }

  return merged;
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
  for (const channel of mergeApplicationChannelRouteRegistrations(input)) {
    const channelRoute: ApplicationChannelRoute = {
      cors: channel.cors,
      kind: "channel",
      method: channel.method,
      path: channel.route,
    };
    if (!addRoute(channelRoute)) {
      continue;
    }
    channelRegistrations.push(channel);
    channelRoutes.push(channelRoute);

    if (
      channel.method !== "WEBSOCKET" &&
      channel.cors !== undefined &&
      !preflightPaths.has(channel.route)
    ) {
      preflightPaths.add(channel.route);
      const preflightRoute: ApplicationChannelPreflightRoute = {
        cors: channel.cors,
        kind: "channel-preflight",
        method: "OPTIONS",
        path: channel.route,
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
    frameworkChannelNames: getAllFrameworkChannelNames(),
    frameworkChannels: getFrameworkChannelDefinitions(),
    manifestChannels: preparedHost.compileResult.manifest.channels,
  });
}

export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return mergeApplicationChannelRouteRegistrations({
    frameworkChannelNames: getAllFrameworkChannelNames(),
    frameworkChannels: getFrameworkChannelDefinitions(),
    manifestChannels: preparedHost.compileResult.manifest.channels,
  });
}
