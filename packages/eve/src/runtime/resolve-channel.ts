import { setChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { HTTP_ADAPTER_KIND } from "#channel/http.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  isHttpRouteDefinition,
  isWebSocketRouteDefinition,
  type RouteDefinition,
} from "#channel/routes.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
import { parseEveRoutePattern } from "#protocol/route-pattern.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  createResolvedModuleSourceRef,
  loadResolvedModuleExport,
  ResolveAgentError,
} from "#runtime/resolve-helpers.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Resolves one compiled channel entry into a runtime-owned definition
 * with a live `handler` (the per-route handler authored via `POST` /
 * `GET` / etc. inside `defineChannel`) and the channel's `receive` hook
 * if the author declared one.
 *
 * Every channel is a `CompiledChannel` from `defineChannel` — including
 * framework-owned sources. The bare `{ fetch, receive? }` Route shape is
 * rejected by {@link normalizeChannelDefinition}.
 */
export async function resolveChannelDefinition(
  definition: CompiledChannelDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedChannelDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "channel",
      moduleMap,
      nodeId,
    });
    const channelDefinition = normalizeChannelDefinition(
      resolvedExportValue,
      `Expected the channel export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" to match the public eve shape.`,
    );

    const sourceRef = createResolvedModuleSourceRef({
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      sourceId: definition.sourceId,
    });

    const matchedRoute = channelDefinition.routes.find(
      (route) =>
        route.method.toUpperCase() === definition.method.toUpperCase() &&
        parseEveRoutePattern(route.path).canonicalPath === definition.urlPath,
    );

    const channelKind = `channel:${definition.name}`;
    setChannelInstrumentationKind(channelDefinition, channelKind);

    const adapter = channelDefinition.adapter;
    if (adapter && adapter.kind !== HTTP_ADAPTER_KIND) {
      // Repurpose `kind` as the unique path-derived registry/discriminant key.
      (adapter as { kind: string }).kind = channelKind;
    }

    const handler = resolveHttpRoute(definition, matchedRoute);
    const websocket = resolveWebSocketRoute(definition, matchedRoute);

    return {
      name: definition.name,
      method: definition.method,
      urlPath: definition.urlPath,
      cors: definition.cors,
      handler,
      websocket,
      receive: channelDefinition.receive,
      definition: channelDefinition,
      adapter,
      turnPolicy: channelDefinition.turnPolicy,
      ...sourceRef,
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to attach the channel definition from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function resolveHttpRoute(
  definition: CompiledChannelDefinition,
  route: RouteDefinition | undefined,
): ResolvedChannelDefinition["handler"] {
  if (definition.method === "WEBSOCKET") {
    return undefined;
  }
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error(
      `Compiled channel route ${definition.method} ${definition.urlPath} is missing from "${definition.logicalPath}".`,
    );
  }
  return route.handler;
}

function resolveWebSocketRoute(
  definition: CompiledChannelDefinition,
  route: RouteDefinition | undefined,
): ResolvedChannelDefinition["websocket"] {
  if (definition.method !== "WEBSOCKET") {
    return undefined;
  }
  if (route === undefined || !isWebSocketRouteDefinition(route)) {
    throw new Error(
      `Compiled WebSocket route ${definition.urlPath} is missing from "${definition.logicalPath}".`,
    );
  }
  return route.handler;
}
