import type {
  CompiledChannelDefinition,
  CompiledChannelRoutePlan,
  CompiledShadowedChannelRoute,
  ComposedSourceDescriptor,
} from "#compiler/manifest.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import { createDiscoverWarningDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  EVE_HOST_ROUTE_INVENTORY,
  routeMethodsIntersect,
  routePathPatternsOverlap,
} from "#shared/host-inventory.js";

/** Stable compile error codes raised while planning channel routes. */
export const CHANNEL_ROUTE_DUPLICATE_CODE = "compile/channel-route-duplicate";
export const CHANNEL_ROUTE_SHADOWED_CODE = "compile/channel-route-shadowed";
export const CHANNEL_PREFLIGHT_COLLISION_CODE = "compile/channel-preflight-collision";
export const CHANNEL_CORS_CONFLICT_CODE = "compile/channel-cors-conflict";
export const RESERVED_ROUTE_COLLISION_CODE = "compile/reserved-route-collision";

/** Compile error raised when route planning cannot produce a valid plan. */
export class ChannelRoutePlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ChannelRoutePlanError";
    this.code = code;
  }
}

/**
 * Plans the compiler-owned channel route plan from the selected compiled
 * channel entries in module order.
 *
 * Different compiled channel sources that normalize to the same concrete
 * method/path identity use deterministic compiled order and first-wins
 * selection; the loser is retained as a shadowed route and reported as a
 * `compile/channel-route-shadowed` warning. The same source emitting one
 * identity twice is a `compile/channel-route-duplicate` error. CORS
 * preflights derive only after ordinary winners are selected.
 */
export function planChannelRoutes(input: {
  readonly channels: readonly CompiledChannelDefinition[];
  readonly describeSource: (sourceId: string) => ComposedSourceDescriptor | undefined;
  readonly diagnostics: DiscoverDiagnostic[];
  readonly nodeId: string;
}): CompiledChannelRoutePlan {
  const effective: CompiledChannelDefinition[] = [];
  const shadowed: CompiledShadowedChannelRoute[] = [];
  const winnersByIdentity = new Map<string, CompiledChannelDefinition>();

  for (const route of input.channels) {
    assertNoReservedRouteCollision(route);
    const identity = `${route.method} ${normalizeRouteIdentityPath(route.urlPath)}`;
    const winner = winnersByIdentity.get(identity);
    if (winner === undefined) {
      winnersByIdentity.set(identity, route);
      effective.push(route);
      continue;
    }
    if (winner.sourceId === route.sourceId) {
      throw new ChannelRoutePlanError(
        CHANNEL_ROUTE_DUPLICATE_CODE,
        `Channel "${route.logicalPath}" declares "${route.method} ${route.urlPath}" more than once.`,
      );
    }
    shadowed.push({
      loser: {
        ...(input.describeSource(route.sourceId) ?? {
          layer: "application",
          logicalPath: route.logicalPath,
          owner: { kind: "application" },
          sourceId: route.sourceId,
          sourcePath: undefined,
        }),
        name: route.name,
      },
      method: route.method,
      urlPath: route.urlPath,
      winningSourceId: winner.sourceId,
    });
    input.diagnostics.push(
      createDiscoverWarningDiagnostic({
        code: CHANNEL_ROUTE_SHADOWED_CODE,
        logicalPath: route.logicalPath,
        message:
          `Channel route "${route.method} ${route.urlPath}" from "${route.logicalPath}" is shadowed by ` +
          `the earlier route from "${winner.logicalPath}".`,
        nodeId: input.nodeId,
        sourceId: route.sourceId,
      }),
    );
  }

  return {
    effective,
    preflight: deriveChannelPreflights(effective),
    shadowed,
  };
}

function deriveChannelPreflights(
  effective: readonly CompiledChannelDefinition[],
): CompiledChannelRoutePlan["preflight"] {
  const corsRoutesByPath = new Map<string, CompiledChannelDefinition[]>();
  const explicitOptionsPaths = new Set(
    effective.filter((route) => route.method === "OPTIONS").map((route) => route.urlPath),
  );

  for (const route of effective) {
    if (route.method === "WEBSOCKET" || route.cors === undefined) {
      continue;
    }
    const routes = corsRoutesByPath.get(route.urlPath) ?? [];
    routes.push(route);
    corsRoutesByPath.set(route.urlPath, routes);
  }

  const preflight: Array<CompiledChannelRoutePlan["preflight"][number]> = [];

  for (const [urlPath, routes] of corsRoutesByPath) {
    const [first, ...rest] = routes;
    if (first === undefined) {
      continue;
    }
    for (const other of rest) {
      if (!corsOptionsEqual(first.cors!, other.cors!)) {
        throw new ChannelRoutePlanError(
          CHANNEL_CORS_CONFLICT_CODE,
          `Selected CORS-enabled routes at "${urlPath}" declare different CORS options ` +
            `("${first.logicalPath}" vs "${other.logicalPath}").`,
        );
      }
    }
    if (explicitOptionsPaths.has(urlPath)) {
      throw new ChannelRoutePlanError(
        CHANNEL_PREFLIGHT_COLLISION_CODE,
        `An explicit OPTIONS route at "${urlPath}" collides with the generated CORS preflight.`,
      );
    }
    preflight.push({
      cors: first.cors!,
      sourceIds: [...new Set(routes.map((route) => route.sourceId))],
      urlPath,
    });
  }

  return preflight;
}

function assertNoReservedRouteCollision(route: CompiledChannelDefinition): void {
  for (const reserved of EVE_HOST_ROUTE_INVENTORY) {
    if (
      routeMethodsIntersect(route.method, reserved.method) &&
      routePathPatternsOverlap(route.urlPath, reserved.pathPattern)
    ) {
      throw new ChannelRoutePlanError(
        RESERVED_ROUTE_COLLISION_CODE,
        `Channel route "${route.method} ${route.urlPath}" from "${route.logicalPath}" collides with ` +
          `the reserved host route "${reserved.method} ${reserved.pathPattern}".`,
      );
    }
  }
}

function corsOptionsEqual(
  left: NormalizedChannelCorsOptions,
  right: NormalizedChannelCorsOptions,
): boolean {
  return JSON.stringify(normalizeCors(left)) === JSON.stringify(normalizeCors(right));
}

function normalizeCors(options: NormalizedChannelCorsOptions): unknown {
  return {
    allowHeaders: options.allowHeaders,
    credentials: options.credentials,
    exposeHeaders: options.exposeHeaders,
    maxAge: options.maxAge,
    methods: options.methods,
    origin: options.origin,
    preflight: options.preflight,
  };
}

/**
 * Route pattern identity ignores parameter names: `:a` and `[a]` segments
 * normalize to one canonical parameter marker.
 */
function normalizeRouteIdentityPath(urlPath: string): string {
  return urlPath
    .split("/")
    .map((segment) =>
      segment.startsWith(":") || (segment.startsWith("[") && segment.endsWith("]"))
        ? ":param"
        : segment,
    )
    .join("/");
}
