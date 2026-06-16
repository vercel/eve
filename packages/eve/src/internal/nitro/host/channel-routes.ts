import type { Nitro, NitroEventHandler } from "nitro/types";

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
import type { NitroArtifactsConfigInput } from "#internal/nitro/host/artifacts-config.js";
import { replaceDevLiveVirtualModules } from "#internal/nitro/host/dev-live-virtual-modules.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

// Must stay under `#nitro/virtual/` — the dev bundler's virtual plugin
// freezes its resolveId filter at config creation, and that prefix is the
// only pattern under which channel routes added while `eve dev` runs can
// still resolve (see dev-live-virtual-modules.ts).
const EVE_CHANNEL_VIRTUAL_ID_PREFIX = "#nitro/virtual/eve-channel/";

interface ChannelRouteNitro {
  options: Pick<Nitro["options"], "handlers" | "virtual">;
  routing: {
    sync(): void;
  };
}

/**
 * One Nitro route registration for an eve channel.
 */
export interface NitroChannelRouteRegistration {
  readonly method: ChannelRouteMethod;
  readonly route: string;
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
    authoredRoutes.push({ method: entry.method, route: entry.urlPath });
  }

  const activeFrameworkRoutes = getFrameworkChannelDefinitions()
    .filter((channel) => !authoredNames.has(channel.name) && !disabledNames.has(channel.name))
    .map(
      (channel): NitroChannelRouteRegistration => ({
        method: channel.method,
        route: channel.urlPath,
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
    readonly artifactsConfig: NitroArtifactsConfigInput;
    readonly registrations: readonly NitroChannelRouteRegistration[];
  },
): void {
  for (const registration of input.registrations) {
    addChannelVirtualHandler(nitro, {
      artifactsConfig: input.artifactsConfig,
      method: registration.method,
      route: registration.route,
    });
  }
}

/**
 * Replaces the currently-mounted eve channel virtual handlers when the route
 * set changes.
 */
export function syncChannelVirtualHandlers(
  nitro: ChannelRouteNitro,
  input: {
    readonly artifactsConfig: NitroArtifactsConfigInput;
    readonly next: readonly NitroChannelRouteRegistration[];
    readonly previous: readonly NitroChannelRouteRegistration[];
  },
): boolean {
  if (areChannelRouteRegistrationsEqual(input.previous, input.next)) {
    return false;
  }

  removeChannelVirtualHandlers(nitro);
  registerChannelVirtualHandlers(nitro, {
    artifactsConfig: input.artifactsConfig,
    registrations: input.next,
  });

  const channelVirtualEntries: Record<string, string> = {};
  for (const [virtualId, template] of Object.entries(nitro.options.virtual)) {
    if (virtualId.startsWith(EVE_CHANNEL_VIRTUAL_ID_PREFIX) && typeof template === "string") {
      channelVirtualEntries[virtualId] = template;
    }
  }
  const mirrored = replaceDevLiveVirtualModules(nitro, {
    entries: channelVirtualEntries,
    prefix: EVE_CHANNEL_VIRTUAL_ID_PREFIX,
  });
  if (!mirrored) {
    console.warn(
      "[eve:dev] channel routes changed but the dev bundler's virtual-module map was not captured; restart `eve dev` to mount the new routes.",
    );
  }

  nitro.routing.sync();
  return true;
}

function createChannelRouteKey(registration: NitroChannelRouteRegistration): string {
  return `${registration.method.toUpperCase()} ${registration.route}`;
}

function addChannelVirtualHandler(
  nitro: Pick<ChannelRouteNitro, "options">,
  input: {
    artifactsConfig: NitroArtifactsConfigInput;
    method: ChannelRouteMethod;
    route: string;
  },
): void {
  const routeKey = createChannelRouteKey(input);
  const virtualId = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${routeKey}`;
  const dispatchModulePath = stringifyEsmImportSpecifier(
    resolvePackageSourceFilePath("src/internal/nitro/routes/channel-dispatch.ts"),
  );
  const nitroModulePath = stringifyEsmImportSpecifier(resolvePackageDependencyPath("nitro"));

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
  nitro.options.virtual[virtualId] = [
    `import { dispatchChannelRequest } from ${dispatchModulePath};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default (event) => dispatchChannelRequest(event, ${JSON.stringify(routeKey)}, config);`,
  ].join("\n");
}

function removeChannelVirtualHandlers(nitro: Pick<ChannelRouteNitro, "options">): void {
  for (let index = nitro.options.handlers.length - 1; index >= 0; index -= 1) {
    const handler = nitro.options.handlers[index];
    if (handler !== undefined && isChannelVirtualHandler(handler)) {
      nitro.options.handlers.splice(index, 1);
    }
  }

  for (const virtualId of Object.keys(nitro.options.virtual)) {
    if (virtualId.startsWith(EVE_CHANNEL_VIRTUAL_ID_PREFIX)) {
      delete nitro.options.virtual[virtualId];
    }
  }
}

function isChannelVirtualHandler(handler: NitroEventHandler): boolean {
  return handler.handler.startsWith(EVE_CHANNEL_VIRTUAL_ID_PREFIX);
}

function areChannelRouteRegistrationsEqual(
  left: readonly NitroChannelRouteRegistration[],
  right: readonly NitroChannelRouteRegistration[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftRegistration = left[index];
    const rightRegistration = right[index];

    if (leftRegistration === undefined || rightRegistration === undefined) {
      return false;
    }

    if (
      leftRegistration.method !== rightRegistration.method ||
      leftRegistration.route !== rightRegistration.route
    ) {
      return false;
    }
  }

  return true;
}
