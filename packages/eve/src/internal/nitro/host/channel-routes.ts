import type { Nitro } from "nitro/types";

import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageDependencyPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import {
  type ApplicationChannelPreflightRoute,
  type ApplicationChannelRoute,
  type ApplicationChannelRouteRegistration,
  computeApplicationChannelRouteRegistrations,
} from "#internal/nitro/host/application-route-registry.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

const EVE_CHANNEL_VIRTUAL_ID_PREFIX = "#nitro/virtual/eve-channel/";

interface ChannelRouteNitro {
  readonly options: Pick<Nitro["options"], "handlers" | "virtual">;
}

/** One active channel binding in the eve-owned application route registry. */
export type NitroChannelRouteRegistration = ApplicationChannelRouteRegistration;

/**
 * Computes the merged set of channel routes the Nitro host should mount.
 */
export function computeChannelRouteRegistrations(
  preparedHost: PreparedApplicationHost,
): readonly NitroChannelRouteRegistration[] {
  return computeApplicationChannelRouteRegistrations(preparedHost);
}

/**
 * Registers virtual Nitro handlers for the provided eve channel routes.
 */
export function registerChannelVirtualHandlers(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly routes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
  },
): void {
  for (const route of input.routes) {
    addChannelVirtualHandler(nitro, {
      artifactsConfig: input.artifactsConfig,
      route,
    });
  }
}

function createChannelRouteKey(input: {
  readonly method: ChannelRouteMethod | "OPTIONS";
  readonly path: string;
}): string {
  return `${input.method.toUpperCase()} ${input.path}`;
}

function addChannelVirtualHandler(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    artifactsConfig: NitroArtifactsConfig;
    route: ApplicationChannelPreflightRoute | ApplicationChannelRoute;
  },
): void {
  if (input.route.kind === "channel-preflight") {
    addChannelCorsPreflightHandler(nitro, input.route);
    return;
  }

  const routeKey = createChannelRouteKey(input.route);
  const virtualId = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${routeKey}`;
  const dispatchModulePath = stringifyEsmImportSpecifier(
    resolvePackageSourceFilePath("src/internal/nitro/routes/channel-dispatch.ts"),
  );
  const nitroModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro"));
  const nitroH3ModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro/h3"));

  if (input.route.method === "WEBSOCKET") {
    nitro.options.handlers.push({
      handler: virtualId,
      route: input.route.path,
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
    method: input.route.method,
    route: input.route.path,
  });
  nitro.options.virtual[virtualId] = [
    ...(input.route.cors === undefined
      ? []
      : [
          `import { handleCors } from ${nitroH3ModulePath};`,
          `const cors = ${JSON.stringify(input.route.cors)};`,
        ]),
    `import { dispatchChannelRequest } from ${dispatchModulePath};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    input.route.cors === undefined
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
  route: ApplicationChannelPreflightRoute,
): void {
  const routeKey = createChannelRouteKey(route);
  const virtualId = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${routeKey}`;
  const nitroH3ModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro/h3"));

  nitro.options.handlers.push({
    handler: virtualId,
    method: "OPTIONS",
    route: route.path,
  });
  nitro.options.virtual[virtualId] = [
    `import { handleCors } from ${nitroH3ModulePath};`,
    `const cors = ${JSON.stringify(route.cors)};`,
    `export default (event) => {`,
    `  const corsResponse = handleCors(event, cors);`,
    `  if (corsResponse !== false) return corsResponse;`,
    `  return new Response(null, { status: 204 });`,
    `};`,
  ].join("\n");
}
