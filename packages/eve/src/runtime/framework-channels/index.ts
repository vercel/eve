import { localDev, vercelOidc } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import {
  getConnectionCallbackChannelDefinitions,
  getConnectionCallbackChannelNames,
} from "#runtime/connections/callback-route.js";
import {
  getSessionCallbackChannelDefinitions,
  getSessionCallbackChannelNames,
} from "#runtime/session-callback-route.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

const EVE_CHANNEL_NAME = "eve";

/**
 * Framework default for the eve channel.
 */
export function getFrameworkChannelDefinitions(): readonly ResolvedChannelDefinition[] {
  const compiled = eveChannel({
    auth: [vercelOidc(), localDev()],
  }) as CompiledChannel;

  const result: ResolvedChannelDefinition[] = [];

  for (const route of compiled.routes) {
    if (!isHttpRouteDefinition(route)) {
      continue;
    }
    result.push({
      name: EVE_CHANNEL_NAME,
      method: route.method.toUpperCase() as "GET" | "POST",
      urlPath: route.path,
      cors: compiled.cors,
      fetch: async (req: Request, ctx: any) => route.handler(req, ctx),
      handler: route.handler,
      adapter: compiled.adapter,
      logicalPath: `framework://channels/${route.path}`,
      sourceId: `eve:framework:${route.method.toLowerCase()}-${route.path}`,
      sourceKind: "module",
    });
  }

  result.push(
    ...getConnectionCallbackChannelDefinitions(),
    ...getSessionCallbackChannelDefinitions(),
  );

  return result;
}

export function getAllFrameworkChannelNames(): ReadonlySet<string> {
  return new Set([
    EVE_CHANNEL_NAME,
    ...getConnectionCallbackChannelNames(),
    ...getSessionCallbackChannelNames(),
  ]);
}
