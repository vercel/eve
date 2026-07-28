import type { Nitro } from "nitro/types";

import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageDependencyPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

const EVE_CHANNEL_VIRTUAL_ID_PREFIX = "#nitro/virtual/eve-channel/";

interface ChannelRouteNitro {
  readonly options: Pick<Nitro["options"], "handlers" | "virtual">;
}

interface LiveChannelRouteNitro extends ChannelRouteNitro {
  readonly vfs: Nitro["vfs"];
}

/**
 * One Nitro route registration for an eve channel.
 */
export interface NitroChannelRouteRegistration {
  readonly method: ChannelRouteMethod;
  readonly route: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

/** Exact Nitro resources one channel registration pass will own. */
export interface NitroChannelRouteResource {
  readonly method?: ChannelRouteMethod | "OPTIONS";
  readonly route: string;
  readonly virtualId: string;
}

/**
 * Computes the merged set of channel routes the Nitro host should mount.
 */
export function computeChannelRouteRegistrations(
  preparedHost: PreparedApplicationHost,
): readonly NitroChannelRouteRegistration[] {
  const manifestChannels = preparedHost.compileResult.manifest.channels;
  const authoredNames = new Set<string>();
  const authoredRoutes: NitroChannelRouteRegistration[] = [];
  const disabledNames = new Set<string>();
  const allFrameworkNames = getAllFrameworkChannelNames();

  for (const entry of manifestChannels) {
    if (entry.kind === "disabled") {
      if (!allFrameworkNames.has(entry.name)) {
        // The runtime resolver throws on this case — surface the same
        // problem here so the dev server fails fast on bad disable files.
        throw new Error(
          `agent/channels/${entry.name}.ts exports disableRoute() but "${entry.name}" is not a framework channel. ` +
            `Rename the file to one of: ${[...allFrameworkNames].sort().join(", ")}.`,
        );
      }
      disabledNames.add(entry.name);
      continue;
    }
    authoredNames.add(entry.name);
    authoredRoutes.push({ method: entry.method, route: entry.urlPath, cors: entry.cors });
  }

  const activeFrameworkRoutes = getFrameworkChannelDefinitions()
    .filter((channel) => !authoredNames.has(channel.name) && !disabledNames.has(channel.name))
    .map(
      (channel): NitroChannelRouteRegistration => ({
        method: channel.method,
        route: channel.urlPath,
        cors: channel.cors,
      }),
    );

  // Concatenate framework defaults first, authored second. Each
  // (method, route) pair is registered exactly once.
  const seen = new Set<string>();
  const merged: NitroChannelRouteRegistration[] = [];
  for (const registration of [...activeFrameworkRoutes, ...authoredRoutes]) {
    const key = createChannelRouteKey(registration);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(registration);
  }

  return merged;
}

function createChannelVirtualId(method: ChannelRouteMethod | "OPTIONS", route: string): string {
  return `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${method.toUpperCase()} ${route}`;
}

/**
 * Describes channel handlers before registration so an embedding host can
 * reject collisions without partially mutating Nitro.
 */
export function describeChannelNitroRouteResources(
  registrations: readonly NitroChannelRouteRegistration[],
): readonly NitroChannelRouteResource[] {
  const preflightRoutes = new Set<string>();
  const resources: NitroChannelRouteResource[] = [];

  for (const registration of registrations) {
    resources.push(
      registration.method === "WEBSOCKET"
        ? {
            route: registration.route,
            virtualId: createChannelVirtualId(registration.method, registration.route),
          }
        : {
            method: registration.method,
            route: registration.route,
            virtualId: createChannelVirtualId(registration.method, registration.route),
          },
    );
    if (registration.cors !== undefined && !preflightRoutes.has(registration.route)) {
      preflightRoutes.add(registration.route);
      resources.push({
        method: "OPTIONS",
        route: registration.route,
        virtualId: createChannelVirtualId("OPTIONS", registration.route),
      });
    }
  }

  return resources;
}

/**
 * Registers virtual Nitro handlers for the provided eve channel routes.
 */
export function registerChannelVirtualHandlers(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly registrations: readonly NitroChannelRouteRegistration[];
  },
): void {
  const preflightRoutes = new Set<string>();
  for (const registration of input.registrations) {
    addChannelVirtualHandler(nitro, {
      artifactsConfig: input.artifactsConfig,
      cors: registration.cors,
      method: registration.method,
      preflightRoutes,
      route: registration.route,
    });
  }
}

function removeChannelVirtualHandlers(
  nitro: Pick<ChannelRouteNitro, "options">,
  registrations: readonly NitroChannelRouteRegistration[],
): void {
  const resources = describeChannelNitroRouteResources(registrations);
  const resourceKeys = new Set(
    resources.map(
      (resource) => `${resource.virtualId}\0${resource.method ?? ""}\0${resource.route}`,
    ),
  );

  nitro.options.handlers = nitro.options.handlers.filter(
    (handler) =>
      !resourceKeys.has(`${handler.handler}\0${handler.method ?? ""}\0${handler.route ?? ""}`),
  );
  for (const resource of resources) {
    delete nitro.options.virtual[resource.virtualId];
  }
}

/** Replaces only channel resources proven to be owned by eve. */
export function replaceChannelVirtualHandlers(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly next: readonly NitroChannelRouteRegistration[];
    readonly previous: readonly NitroChannelRouteRegistration[];
  },
): void {
  removeChannelVirtualHandlers(nitro, input.previous);
  registerChannelVirtualHandlers(nitro, {
    artifactsConfig: input.artifactsConfig,
    registrations: input.next,
  });
}

/** Replaces channel resources in an initialized Nitro development runtime. */
export function replaceLiveChannelVirtualHandlers(
  nitro: LiveChannelRouteNitro,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly next: readonly NitroChannelRouteRegistration[];
    readonly previous: readonly NitroChannelRouteRegistration[];
  },
): void {
  replaceChannelVirtualHandlers(nitro, input);

  for (const resource of describeChannelNitroRouteResources(input.previous)) {
    nitro.vfs.delete(resource.virtualId);
  }
  for (const resource of describeChannelNitroRouteResources(input.next)) {
    const template = nitro.options.virtual[resource.virtualId];
    if (template === undefined) {
      throw new Error(`Missing eve channel virtual handler: ${resource.virtualId}`);
    }
    const module = { id: resource.virtualId, template };
    const virtualModule: Nitro["vfs"] extends Map<string, infer Entry>
      ? Entry & { readonly module: typeof module }
      : never = {
      module,
      render: () => (typeof template === "function" ? template() : template),
    };
    nitro.vfs.set(resource.virtualId, virtualModule);
  }
}

function createChannelRouteKey(registration: NitroChannelRouteRegistration): string {
  return `${registration.method.toUpperCase()} ${registration.route}`;
}

function addChannelVirtualHandler(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    artifactsConfig: NitroArtifactsConfig;
    cors?: NormalizedChannelCorsOptions;
    method: ChannelRouteMethod;
    preflightRoutes: Set<string>;
    route: string;
  },
): void {
  const routeKey = createChannelRouteKey(input);
  const virtualId = createChannelVirtualId(input.method, input.route);
  const dispatchModulePath = stringifyEsmImportSpecifier(
    resolvePackageSourceFilePath("src/internal/nitro/routes/channel-dispatch.ts"),
  );
  const nitroModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro"));
  const nitroH3ModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro/h3"));

  if (input.method === "WEBSOCKET") {
    nitro.options.handlers.push({
      handler: virtualId,
      route: input.route,
    });
    nitro.options.virtual[virtualId] = [
      `import { defineWebSocketHandler } from ${nitroModulePath};`,
      `import { dispatchChannelWebSocketRequest } from ${dispatchModulePath};`,
      `const config = ${JSON.stringify(input.artifactsConfig)};`,
      `export default defineWebSocketHandler((event) => dispatchChannelWebSocketRequest(event, ${JSON.stringify(routeKey)}, config));`,
    ].join("\n");
    return;
  }

  nitro.options.handlers.push({
    handler: virtualId,
    method: input.method,
    route: input.route,
  });
  if (input.cors !== undefined) {
    addChannelCorsPreflightHandler(nitro, {
      cors: input.cors,
      nitroH3ModulePath,
      preflightRoutes: input.preflightRoutes,
      route: input.route,
    });
  }
  nitro.options.virtual[virtualId] = [
    ...(input.cors === undefined
      ? []
      : [
          `import { handleCors } from ${nitroH3ModulePath};`,
          `const cors = ${JSON.stringify(input.cors)};`,
        ]),
    `import { dispatchChannelRequest } from ${dispatchModulePath};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    input.cors === undefined
      ? `export default (event) => dispatchChannelRequest(event, ${JSON.stringify(routeKey)}, config);`
      : [
          `export default (event) => {`,
          `  const corsResponse = handleCors(event, cors);`,
          `  if (corsResponse !== false) return corsResponse;`,
          `  return dispatchChannelRequest(event, ${JSON.stringify(routeKey)}, config);`,
          `};`,
        ].join("\n"),
  ].join("\n");
}

function addChannelCorsPreflightHandler(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    cors: NormalizedChannelCorsOptions;
    nitroH3ModulePath: string;
    preflightRoutes: Set<string>;
    route: string;
  },
): void {
  if (input.preflightRoutes.has(input.route)) {
    return;
  }
  input.preflightRoutes.add(input.route);

  const virtualId = createChannelVirtualId("OPTIONS", input.route);

  nitro.options.handlers.push({
    handler: virtualId,
    method: "OPTIONS",
    route: input.route,
  });
  nitro.options.virtual[virtualId] = [
    `import { handleCors } from ${input.nitroH3ModulePath};`,
    `const cors = ${JSON.stringify(input.cors)};`,
    `export default (event) => {`,
    `  const corsResponse = handleCors(event, cors);`,
    `  if (corsResponse !== false) return corsResponse;`,
    `  return new Response(null, { status: 204 });`,
    `};`,
  ].join("\n");
}
