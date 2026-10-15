import { setChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { HTTP_ADAPTER_KIND } from "#channel/http.js";
import type {
  CompiledChannelDefinition,
  CompiledReceiveOnlyChannelDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  isHttpRouteDefinition,
  isWebSocketRouteDefinition,
  type RouteDefinition,
} from "#channel/routes.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
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
 * Every authored channel is a `CompiledChannel` from `defineChannel` —
 * the bare `{ fetch, receive? }` Route shape is rejected by
 * {@link normalizeChannelDefinition}. Framework-internal channels
 * (the connection callback route, the `eve` session channel) build
 * `ResolvedChannelDefinition` values directly and do not flow through
 * this resolver.
 */
export async function resolveChannelDefinition(
  definition: CompiledChannelDefinition | CompiledReceiveOnlyChannelDefinition,
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

    // Receive-only channels have no compiled route to match.
    const routeEntry = "method" in definition ? definition : undefined;
    const matchedRoute = routeEntry
      ? channelDefinition.routes.find(
          (route) =>
            route.method.toUpperCase() === routeEntry.method.toUpperCase() &&
            route.path === routeEntry.urlPath,
        )
      : undefined;

    const channelKind = `channel:${definition.name}`;
    setChannelInstrumentationKind(channelDefinition, channelKind);

    const adapter = channelDefinition.adapter;
    if (adapter && adapter.kind !== HTTP_ADAPTER_KIND) {
      // Repurpose `kind` as the unique path-derived registry/discriminant key.
      (adapter as { kind: string }).kind = channelKind;
    }

    const httpRoute = routeEntry && resolveHttpRoute(routeEntry, matchedRoute);
    const websocketRoute = routeEntry && resolveWebSocketRoute(routeEntry, matchedRoute);

    return {
      name: definition.name,
      method: routeEntry?.method,
      urlPath: routeEntry?.urlPath,
      cors: routeEntry?.cors,
      fetch: async (req: Request, ctx: any) => {
        if (httpRoute) return httpRoute.handler(req, ctx);
        return Response.json({ error: "No matching route handler.", ok: false }, { status: 404 });
      },
      handler: httpRoute?.handler,
      websocket: websocketRoute?.handler,
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
) {
  if (route === undefined || definition.method === "WEBSOCKET" || !isHttpRouteDefinition(route)) {
    return undefined;
  }
  return route;
}

function resolveWebSocketRoute(
  definition: CompiledChannelDefinition,
  route: RouteDefinition | undefined,
) {
  if (
    route === undefined ||
    definition.method !== "WEBSOCKET" ||
    !isWebSocketRouteDefinition(route)
  ) {
    return undefined;
  }
  return route;
}
