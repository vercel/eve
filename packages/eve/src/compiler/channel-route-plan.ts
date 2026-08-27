import type {
  CompiledChannelDefinition,
  CompiledChannelPreflightDefinition,
  CompiledChannelRoutePlan,
  CompiledShadowedChannelRoute,
} from "#compiler/manifest.js";
import type { AgentModuleBinding, AgentSourceDescriptor } from "#compiler/source-graph.js";
import {
  createChannelRouteShadowedDiagnostic,
  type CompilerDiagnostic,
} from "#compiler/diagnostics.js";
import { HOST_HTTP_INVENTORY } from "#framework/host-inventory.js";

export function createCompiledChannelRoutePlan(input: {
  readonly bindings: Readonly<Record<string, AgentModuleBinding>>;
  readonly channels: readonly CompiledChannelDefinition[];
  readonly diagnostics?: CompilerDiagnostic[];
  readonly nodeId: string;
  readonly sources: Readonly<Record<string, AgentSourceDescriptor>>;
}): CompiledChannelRoutePlan {
  const effective: CompiledChannelDefinition[] = [];
  const shadowed: CompiledShadowedChannelRoute[] = [];

  for (const channel of input.channels) {
    const reserved = HOST_HTTP_INVENTORY.find((host) => routesOverlap(channel, host));
    if (reserved !== undefined) {
      throw new Error(
        `compile/reserved-route-collision: ${channel.method} ${channel.urlPath} overlaps reserved ${reserved.method} ${reserved.path}.`,
      );
    }
    const winner = effective.find((candidate) => routesOverlap(channel, candidate));
    if (winner === undefined) {
      effective.push(channel);
      continue;
    }
    if (winner.sourceId === channel.sourceId) {
      throw new Error(
        `compile/channel-route-duplicate: source "${channel.sourceId}" emits ${channel.method} ${channel.urlPath} more than once.`,
      );
    }
    const binding = input.bindings[channel.sourceId];
    const source = input.sources[channel.sourceId];
    const winnerSource = input.sources[winner.sourceId];
    if (binding === undefined || source === undefined || winnerSource === undefined) {
      throw new Error(`Channel source "${channel.sourceId}" has no compiled binding.`);
    }
    shadowed.push({
      method: channel.method,
      source,
      urlPath: channel.urlPath,
      winnerSourceId: winner.sourceId,
    });
    input.diagnostics?.push(
      createChannelRouteShadowedDiagnostic({
        loser: source,
        method: channel.method,
        nodeId: input.nodeId,
        urlPath: channel.urlPath,
        winner: winnerSource,
      }),
    );
  }

  const preflight = derivePreflights(effective);
  return {
    effective: Object.freeze(effective),
    preflight: Object.freeze(preflight),
    shadowed: Object.freeze(shadowed),
  };
}

function derivePreflights(
  effective: readonly CompiledChannelDefinition[],
): CompiledChannelPreflightDefinition[] {
  const corsRoutes = effective.filter(
    (channel) => channel.method !== "WEBSOCKET" && channel.cors !== undefined,
  );
  for (const [index, route] of corsRoutes.entries()) {
    const conflict = corsRoutes
      .slice(index + 1)
      .find(
        (candidate) =>
          routePatternsOverlap(route.urlPath, candidate.urlPath) &&
          JSON.stringify(route.cors) !== JSON.stringify(candidate.cors),
      );
    if (conflict !== undefined) {
      throw new Error(
        `compile/channel-cors-conflict: overlapping routes at "${route.urlPath}" and "${conflict.urlPath}" declare different CORS policies.`,
      );
    }
  }

  const byPath = new Map<string, CompiledChannelDefinition[]>();
  for (const channel of corsRoutes) {
    const identity = normalizeRoutePattern(channel.urlPath);
    const routes = byPath.get(identity) ?? [];
    routes.push(channel);
    byPath.set(identity, routes);
  }
  const preflights: CompiledChannelPreflightDefinition[] = [];
  for (const routes of byPath.values()) {
    const first = routes[0]!;
    const normalizedCors = JSON.stringify(first.cors);
    if (routes.some((route) => JSON.stringify(route.cors) !== normalizedCors)) {
      throw new Error(
        `compile/channel-cors-conflict: routes at "${first.urlPath}" declare different CORS policies.`,
      );
    }
    if (
      effective.some(
        (route) => route.method === "OPTIONS" && routePatternsOverlap(route.urlPath, first.urlPath),
      )
    ) {
      throw new Error(
        `compile/channel-preflight-collision: explicit OPTIONS route overlaps generated preflight at "${first.urlPath}".`,
      );
    }
    preflights.push({
      cors: first.cors!,
      method: "OPTIONS",
      sourceIds: [...new Set(routes.map((route) => route.sourceId))],
      urlPath: first.urlPath,
    });
  }
  return preflights;
}

function routesOverlap(
  left: { readonly method: string; readonly urlPath: string },
  right: { readonly method: string; readonly path?: string; readonly urlPath?: string },
): boolean {
  return (
    methodsOverlap(left.method, right.method) &&
    routePatternsOverlap(left.urlPath, right.path ?? right.urlPath!)
  );
}

function methodsOverlap(left: string, right: string): boolean {
  return left === "ALL" || right === "ALL" || left === right;
}

function routePatternsOverlap(left: string, right: string): boolean {
  const leftSegments = splitRoute(left);
  const rightSegments = splitRoute(right);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every(
    (segment, index) =>
      isParameter(segment) ||
      isParameter(rightSegments[index]!) ||
      segment === rightSegments[index],
  );
}

function normalizeRoutePattern(path: string): string {
  return splitRoute(path)
    .map((segment) => (isParameter(segment) ? ":" : segment))
    .join("/");
}

function splitRoute(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, "").split("/");
}

function isParameter(segment: string): boolean {
  return segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment);
}
