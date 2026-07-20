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

/**
 * One Nitro route registration for an eve channel.
 */
export interface NitroChannelRouteRegistration {
  readonly method: ChannelRouteMethod;
  readonly route: string;
  readonly cors?: NormalizedChannelCorsOptions;
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
  const virtualId = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${routeKey}`;
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

  const routeKey = `OPTIONS ${input.route}`;
  const virtualId = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${routeKey}`;

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
