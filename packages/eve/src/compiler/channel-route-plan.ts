import {
  type NormalizedChannelCorsOptions,
  validateNormalizedChannelCorsOptions,
} from "#channel/cors.js";
import { isChannelRouteMethod } from "#channel/routes.js";
import type {
  CompiledChannelDefinition,
  CompiledChannelPreflightDefinition,
  CompiledChannelRoutePlan,
  CompiledShadowedChannelRoute,
} from "#compiler/manifest.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";
import { CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE } from "#shared/compiler-diagnostics.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import { getHostRouteReservations } from "#protocol/host-route-inventory.js";
import {
  EveRoutePatternError,
  eveRoutePatternsOverlap,
  parseEveRoutePattern,
  type ParsedEveRoutePattern,
} from "#protocol/route-pattern.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";

export { CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE } from "#shared/compiler-diagnostics.js";
export const CHANNEL_ROUTE_DUPLICATE_DIAGNOSTIC_CODE = "compile/channel-route-duplicate";
export const CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE =
  "compile/channel-route-invalid-pattern";
export const CHANNEL_WEBSOCKET_GET_COLLISION_DIAGNOSTIC_CODE =
  "compile/channel-websocket-get-collision";
export const CHANNEL_PREFLIGHT_COLLISION_DIAGNOSTIC_CODE = "compile/channel-preflight-collision";
export const CHANNEL_CORS_CONFLICT_DIAGNOSTIC_CODE = "compile/channel-cors-conflict";
export const RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE = "compile/reserved-route-collision";

const RESERVED_HOST_ROUTES = getHostRouteReservations();

export class ChannelRoutePlanningError extends Error {
  readonly diagnostic: CompilerDiagnostic;

  constructor(diagnostic: CompilerDiagnostic) {
    super(`[${diagnostic.code}] ${diagnostic.message}`);
    this.name = "ChannelRoutePlanningError";
    this.diagnostic = diagnostic;
  }
}

export function createCompiledChannelRoutePlan(input: {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly diagnostics: CompilerDiagnostic[];
  readonly nodeId: string;
  readonly routes: readonly CompiledChannelDefinition[];
}): CompiledChannelRoutePlan {
  const effective: CompiledChannelDefinition[] = [];
  const shadowed: CompiledShadowedChannelRoute[] = [];
  const firstDeclarationBySourceIdentity = new Map<string, CompiledChannelDefinition>();
  const winnersByIdentity = new Map<string, CompiledChannelDefinition>();

  for (const candidate of input.routes) {
    const route = canonicalizeRouteOrThrow(candidate, input.nodeId);
    assertNoReservedRouteCollision(route, input.nodeId);
    const identity = createChannelRouteIdentity(route.method, route.urlPath);
    const sourceIdentity = `${route.sourceId}\0${identity}`;
    const firstDeclaration = firstDeclarationBySourceIdentity.get(sourceIdentity);
    if (firstDeclaration !== undefined) {
      throwRouteError({
        code: CHANNEL_ROUTE_DUPLICATE_DIAGNOSTIC_CODE,
        message: `Channel source "${route.logicalPath}" declares ${route.method} ${route.urlPath} more than once.`,
        nodeId: input.nodeId,
        route,
        related: [{ label: "first declaration", route: firstDeclaration }],
      });
    }
    firstDeclarationBySourceIdentity.set(sourceIdentity, route);
    const winner = winnersByIdentity.get(identity);

    if (winner === undefined) {
      winnersByIdentity.set(identity, route);
      effective.push(route);
      continue;
    }

    const record: CompiledShadowedChannelRoute = {
      loser: {
        binding: requireRouteBinding(route, input.bindings),
        route,
      },
      method: route.method,
      pathPattern: parseEveRoutePattern(route.urlPath).identityPattern,
      winningSourceId: winner.sourceId,
    };
    shadowed.push(record);
    input.diagnostics.push({
      channelRoute: {
        method: record.method,
        pathPattern: record.pathPattern,
      },
      code: CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE,
      logicalPath: route.logicalPath,
      message: `${route.method} ${route.urlPath} from "${route.logicalPath}" is shadowed by "${winner.logicalPath}".`,
      nodeId: input.nodeId,
      related: [
        {
          label: "winner",
          logicalPath: winner.logicalPath,
          nodeId: input.nodeId,
          sourceId: winner.sourceId,
        },
      ],
      severity: "warning",
      sourceId: route.sourceId,
    });
  }

  assertNoWebSocketGetCollision(effective, input.nodeId);

  return {
    effective,
    preflight: createPreflightPlan(effective, input.nodeId),
    shadowed,
  };
}

export function createChannelRouteIdentity(method: ChannelRouteMethod, path: string): string {
  return `${method} ${parseEveRoutePattern(path).identityPattern}`;
}

/** Validates relational invariants that a structural schema cannot express. */
export function validateCompiledChannelRoutePlan(
  plan: CompiledChannelRoutePlan,
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
): readonly string[] {
  const issues: string[] = [];
  const effectiveByIdentity = new Map<string, CompiledChannelDefinition>();
  const effectiveByPattern = new Map<string, CompiledChannelDefinition[]>();
  const parsedEffective: CompiledChannelDefinition[] = [];

  for (const route of plan.effective) {
    const methodIsValid = validateStoredMethod(
      route.method,
      `channelRoutes.effective route "${String(route.method)} ${route.urlPath}"`,
      issues,
    );
    validateStoredCors(
      route.cors,
      `channelRoutes.effective route "${route.method} ${route.urlPath}"`,
      issues,
    );
    const parsed = validateStoredPattern({
      issues,
      label: `channelRoutes.effective route "${route.method} ${route.urlPath}"`,
      path: route.urlPath,
    });
    if (parsed === undefined) continue;
    if (!methodIsValid) continue;
    parsedEffective.push(route);
    if (parsed.canonicalPath !== route.urlPath) {
      issues.push(
        `channelRoutes.effective route "${route.method} ${route.urlPath}" is not canonical; expected "${parsed.canonicalPath}".`,
      );
    }

    const identity = formatRouteIdentity(route.method, parsed.identityPattern);
    if (effectiveByIdentity.has(identity)) {
      issues.push(`channelRoutes.effective contains duplicate identity "${identity}".`);
    } else {
      effectiveByIdentity.set(identity, route);
    }
    if (bindings[route.sourceId] === undefined) {
      issues.push(`channelRoutes.effective references unbound source "${route.sourceId}".`);
    }
    const pattern = parsed.identityPattern;
    const routesAtPattern = effectiveByPattern.get(pattern) ?? [];
    routesAtPattern.push(route);
    effectiveByPattern.set(pattern, routesAtPattern);
    const reserved = RESERVED_HOST_ROUTES.find(
      (host) =>
        channelAndHostMethodsOverlap(route.method, host.method) &&
        eveRoutePatternsOverlap(route.urlPath, host.pathPattern),
    );
    if (reserved !== undefined) {
      issues.push(
        `channelRoutes.effective route "${identity}" overlaps reserved host route "${reserved.method} ${reserved.pathPattern}".`,
      );
    }
  }

  for (let index = 0; index < parsedEffective.length; index++) {
    const first = parsedEffective[index]!;
    for (const second of parsedEffective.slice(index + 1)) {
      if (!eveRoutePatternsOverlap(first.urlPath, second.urlPath)) continue;
      if (isWebSocketGetPair(first.method, second.method)) {
        issues.push(
          `channelRoutes.effective routes "${first.method} ${first.urlPath}" and "${second.method} ${second.urlPath}" overlap on the WebSocket GET transport.`,
        );
      }
      if (isOptionsAndCorsCausePair(first, second)) {
        issues.push(
          `channelRoutes.effective routes "${first.method} ${first.urlPath}" and "${second.method} ${second.urlPath}" overlap between explicit OPTIONS and a CORS preflight cause.`,
        );
      }
      if (
        isCorsPreflightCause(first) &&
        isCorsPreflightCause(second) &&
        !equalCorsOptions(first.cors!, second.cors!)
      ) {
        issues.push(
          `channelRoutes.effective routes "${first.method} ${first.urlPath}" and "${second.method} ${second.urlPath}" have conflicting CORS options over an overlapping match space.`,
        );
      }
    }
  }

  const shadowedLoserIdentities = new Set<string>();
  for (const record of plan.shadowed) {
    const recordMethodIsValid = validateStoredMethod(
      record.method,
      `channelRoutes.shadowed record for "${String(record.method)} ${record.pathPattern}"`,
      issues,
    );
    const loserMethodIsValid = validateStoredMethod(
      record.loser.route.method,
      `channelRoutes.shadowed loser "${String(record.loser.route.method)} ${record.loser.route.urlPath}"`,
      issues,
    );
    validateStoredCors(
      record.loser.route.cors,
      `channelRoutes.shadowed loser "${record.loser.route.method} ${record.loser.route.urlPath}"`,
      issues,
    );
    const loserPattern = validateStoredPattern({
      issues,
      label: `channelRoutes.shadowed loser "${record.loser.route.method} ${record.loser.route.urlPath}"`,
      path: record.loser.route.urlPath,
    });
    const recordPattern = validateStoredPattern({
      issues,
      label: `channelRoutes.shadowed pattern "${record.pathPattern}"`,
      path: record.pathPattern,
    });
    if (loserPattern === undefined || recordPattern === undefined) continue;
    if (!recordMethodIsValid || !loserMethodIsValid) continue;
    if (loserPattern.canonicalPath !== record.loser.route.urlPath) {
      issues.push(
        `channelRoutes.shadowed loser "${record.loser.route.method} ${record.loser.route.urlPath}" is not canonical; expected "${loserPattern.canonicalPath}".`,
      );
    }
    if (recordPattern.canonicalPath !== record.pathPattern) {
      issues.push(
        `channelRoutes.shadowed pattern "${record.pathPattern}" is not canonical; expected "${recordPattern.canonicalPath}".`,
      );
    }

    const identity = formatRouteIdentity(record.method, recordPattern.identityPattern);
    const actualLoserIdentity = formatRouteIdentity(
      record.loser.route.method,
      loserPattern.identityPattern,
    );
    const loserKey = `${record.loser.route.sourceId}\0${actualLoserIdentity}`;
    if (shadowedLoserIdentities.has(loserKey)) {
      issues.push(
        `channelRoutes.shadowed contains duplicate loser identity "${record.loser.route.sourceId} ${actualLoserIdentity}".`,
      );
    } else {
      shadowedLoserIdentities.add(loserKey);
    }
    const winner = effectiveByIdentity.get(identity);
    if (winner?.sourceId !== record.winningSourceId) {
      issues.push(`channelRoutes.shadowed has no matching winner for "${identity}".`);
    }
    if (
      record.method !== record.loser.route.method ||
      record.pathPattern !== loserPattern.identityPattern
    ) {
      issues.push(`channelRoutes.shadowed loser identity does not match "${identity}".`);
    }
    const selectedBinding = bindings[record.loser.route.sourceId];
    if (selectedBinding === undefined) {
      issues.push(
        `channelRoutes.shadowed references unbound loser source "${record.loser.route.sourceId}".`,
      );
    } else if (!equalRouteBindings(selectedBinding, record.loser.binding)) {
      issues.push(
        `channelRoutes.shadowed loser "${record.loser.route.sourceId}" does not match its selected binding.`,
      );
    }
    if (record.loser.binding.logicalPath !== record.loser.route.logicalPath) {
      issues.push(
        `channelRoutes.shadowed loser "${record.loser.route.sourceId}" has a mismatched binding.`,
      );
    }
    if (record.loser.route.sourceId === record.winningSourceId) {
      issues.push(`channelRoutes.shadowed records a same-source duplicate for "${identity}".`);
    }
  }

  const preflightByPattern = new Map<string, CompiledChannelPreflightDefinition[]>();
  for (const preflight of plan.preflight) {
    validateStoredCors(
      preflight.cors,
      `channelRoutes.preflight pattern "${preflight.pathPattern}"`,
      issues,
    );
    const parsed = validateStoredPattern({
      issues,
      label: `channelRoutes.preflight pattern "${preflight.pathPattern}"`,
      path: preflight.pathPattern,
    });
    if (parsed === undefined) continue;
    if (parsed.canonicalPath !== preflight.pathPattern) {
      issues.push(
        `channelRoutes.preflight pattern "${preflight.pathPattern}" is not canonical; expected "${parsed.canonicalPath}".`,
      );
    }
    const pattern = parsed.identityPattern;
    const entries = preflightByPattern.get(pattern) ?? [];
    entries.push(preflight);
    preflightByPattern.set(pattern, entries);
    if (entries.length > 1) {
      issues.push(`channelRoutes.preflight contains duplicate pattern "${pattern}".`);
    }
    const causeIds = new Set(preflight.sourceIds);
    if (causeIds.size === 0 || causeIds.size !== preflight.sourceIds.length) {
      issues.push(`channelRoutes.preflight at "${preflight.pathPattern}" has invalid causes.`);
      continue;
    }
    const causes = plan.effective.filter((route) => {
      const routePattern = tryParseEveRoutePattern(route.urlPath);
      return (
        routePattern?.identityPattern === pattern &&
        route.method !== "OPTIONS" &&
        route.method !== "WEBSOCKET" &&
        route.cors !== undefined
      );
    });
    const expectedSourceIds = new Set(causes.map((route) => route.sourceId));
    if (
      expectedSourceIds.size !== causeIds.size ||
      [...causeIds].some((sourceId) => !expectedSourceIds.has(sourceId)) ||
      causes.some((route) => !equalCorsOptions(route.cors!, preflight.cors))
    ) {
      issues.push(`channelRoutes.preflight at "${preflight.pathPattern}" has dangling causes.`);
    }
    if (
      plan.effective.some(
        (route) =>
          route.method === "OPTIONS" &&
          tryParseEveRoutePattern(route.urlPath) !== undefined &&
          eveRoutePatternsOverlap(route.urlPath, preflight.pathPattern),
      )
    ) {
      issues.push(
        `channelRoutes.preflight at "${preflight.pathPattern}" overlaps an explicit OPTIONS route.`,
      );
    }
  }

  for (const [pattern, routes] of effectiveByPattern) {
    const corsRoutes = routes.filter(
      (route) =>
        route.method !== "OPTIONS" && route.method !== "WEBSOCKET" && route.cors !== undefined,
    );
    if (corsRoutes.length === 0) continue;

    if ((preflightByPattern.get(pattern)?.length ?? 0) === 0) {
      issues.push(`channelRoutes.preflight is missing required pattern "${pattern}".`);
    }
  }

  for (const pattern of preflightByPattern.keys()) {
    const routes = effectiveByPattern.get(pattern) ?? [];
    if (
      !routes.some(
        (route) =>
          route.method !== "OPTIONS" && route.method !== "WEBSOCKET" && route.cors !== undefined,
      )
    ) {
      issues.push(`channelRoutes.preflight has no selected CORS route at "${pattern}".`);
    }
  }

  return issues;
}

/** Enforces route-plan semantics at compiled artifact construction boundaries. */
export function assertValidCompiledChannelRoutePlan(input: {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly nodeId: string;
  readonly plan: CompiledChannelRoutePlan;
}): void {
  const issues = validateCompiledChannelRoutePlan(input.plan, input.bindings);
  if (issues.length === 0) return;
  throw new Error(
    `Compiled node "${input.nodeId}" has an invalid channel route plan:\n${issues
      .map((issue) => `- ${issue}`)
      .join("\n")}`,
  );
}

function createPreflightPlan(
  effective: readonly CompiledChannelDefinition[],
  nodeId: string,
): readonly CompiledChannelPreflightDefinition[] {
  const explicitOptions: CompiledChannelDefinition[] = [];
  const corsRoutes: CompiledChannelDefinition[] = [];
  const corsRoutesByPattern = new Map<string, CompiledChannelDefinition[]>();

  for (const route of effective) {
    const pattern = parseEveRoutePattern(route.urlPath).identityPattern;
    if (route.method === "OPTIONS") {
      explicitOptions.push(route);
      continue;
    }
    if (route.method === "WEBSOCKET" || route.cors === undefined) continue;
    corsRoutes.push(route);
    const routes = corsRoutesByPattern.get(pattern) ?? [];
    routes.push(route);
    corsRoutesByPattern.set(pattern, routes);
  }

  const preflight: CompiledChannelPreflightDefinition[] = [];
  for (const [pathPattern, routes] of corsRoutesByPattern) {
    const collidingOptions = explicitOptions.find((optionsRoute) =>
      routes.some((route) => eveRoutePatternsOverlap(optionsRoute.urlPath, route.urlPath)),
    );
    if (collidingOptions !== undefined) {
      throwRouteError({
        code: CHANNEL_PREFLIGHT_COLLISION_DIAGNOSTIC_CODE,
        message: `Explicit OPTIONS route "${collidingOptions.logicalPath}" collides with generated CORS preflight for ${pathPattern}.`,
        nodeId,
        route: collidingOptions,
        related: routes.map((route) => ({ label: "preflight cause", route })),
      });
    }

    const first = routes[0]!;
    preflight.push({
      cors: first.cors!,
      pathPattern: first.urlPath,
      sourceIds: [...new Set(routes.map((route) => route.sourceId))],
    });
  }

  assertNoOverlappingCorsConflicts(corsRoutes, nodeId);

  return preflight;
}

function assertNoOverlappingCorsConflicts(
  routes: readonly CompiledChannelDefinition[],
  nodeId: string,
): void {
  for (let index = 0; index < routes.length; index++) {
    const first = routes[index]!;
    for (const second of routes.slice(index + 1)) {
      if (!eveRoutePatternsOverlap(first.urlPath, second.urlPath)) continue;
      if (equalCorsOptions(first.cors!, second.cors!)) continue;
      throwRouteError({
        code: CHANNEL_CORS_CONFLICT_DIAGNOSTIC_CODE,
        message: `${second.method} ${second.urlPath} and ${first.method} ${first.urlPath} declare conflicting CORS options over an overlapping match space.`,
        nodeId,
        route: second,
        related: [{ label: "conflicting route", route: first }],
      });
    }
  }
}

function assertNoReservedRouteCollision(route: CompiledChannelDefinition, nodeId: string): void {
  const collision = RESERVED_HOST_ROUTES.find(
    (host) =>
      channelAndHostMethodsOverlap(route.method, host.method) &&
      eveRoutePatternsOverlap(route.urlPath, host.pathPattern),
  );
  if (collision === undefined) return;

  throwRouteError({
    code: RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE,
    message: `${route.method} ${route.urlPath} collides with reserved host route ${collision.method} ${collision.pathPattern}.`,
    nodeId,
    route,
  });
}

function assertNoWebSocketGetCollision(
  routes: readonly CompiledChannelDefinition[],
  nodeId: string,
): void {
  for (let index = 0; index < routes.length; index++) {
    const first = routes[index]!;
    for (const second of routes.slice(index + 1)) {
      if (!isWebSocketGetPair(first.method, second.method)) continue;
      if (!eveRoutePatternsOverlap(first.urlPath, second.urlPath)) continue;
      throwRouteError({
        code: CHANNEL_WEBSOCKET_GET_COLLISION_DIAGNOSTIC_CODE,
        message: `${second.method} ${second.urlPath} overlaps ${first.method} ${first.urlPath} on the WebSocket GET transport.`,
        nodeId,
        route: second,
        related: [{ label: "conflicting route", route: first }],
      });
    }
  }
}

function canonicalizeRouteOrThrow(
  route: CompiledChannelDefinition,
  nodeId: string,
): CompiledChannelDefinition {
  let parsed: ParsedEveRoutePattern;
  try {
    parsed = parseEveRoutePattern(route.urlPath);
  } catch (error) {
    if (!(error instanceof EveRoutePatternError)) throw error;
    throwRouteError({
      code: CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE,
      message: `${route.method} ${route.urlPath} is not a valid channel route pattern: ${error.reason}`,
      nodeId,
      route,
    });
  }

  return parsed.canonicalPath === route.urlPath
    ? route
    : { ...route, urlPath: parsed.canonicalPath };
}

function channelAndHostMethodsOverlap(
  channelMethod: ChannelRouteMethod,
  hostMethod: ChannelRouteMethod | "ALL",
): boolean {
  return hostMethod === "ALL" || toNitroHttpMethod(channelMethod) === hostMethod;
}

function toNitroHttpMethod(method: ChannelRouteMethod): Exclude<ChannelRouteMethod, "WEBSOCKET"> {
  return method === "WEBSOCKET" ? "GET" : method;
}

function isWebSocketGetPair(left: ChannelRouteMethod, right: ChannelRouteMethod): boolean {
  return (left === "WEBSOCKET" && right === "GET") || (left === "GET" && right === "WEBSOCKET");
}

function isCorsPreflightCause(route: CompiledChannelDefinition): boolean {
  return route.method !== "OPTIONS" && route.method !== "WEBSOCKET" && route.cors !== undefined;
}

function isOptionsAndCorsCausePair(
  left: CompiledChannelDefinition,
  right: CompiledChannelDefinition,
): boolean {
  return (
    (left.method === "OPTIONS" && isCorsPreflightCause(right)) ||
    (right.method === "OPTIONS" && isCorsPreflightCause(left))
  );
}

function formatRouteIdentity(method: ChannelRouteMethod, identityPattern: string): string {
  return `${method} ${identityPattern}`;
}

function tryParseEveRoutePattern(path: string): ParsedEveRoutePattern | undefined {
  try {
    return parseEveRoutePattern(path);
  } catch {
    return undefined;
  }
}

function validateStoredMethod(method: unknown, label: string, issues: string[]): boolean {
  if (isChannelRouteMethod(method)) return true;
  issues.push(`${label} has an unsupported method.`);
  return false;
}

function validateStoredPattern(input: {
  readonly issues: string[];
  readonly label: string;
  readonly path: string;
}): ParsedEveRoutePattern | undefined {
  try {
    return parseEveRoutePattern(input.path);
  } catch (error) {
    const reason = error instanceof EveRoutePatternError ? error.reason : "invalid route value.";
    input.issues.push(
      `[${CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE}] ${input.label} is invalid: ${reason}`,
    );
    return undefined;
  }
}

function validateStoredCors(
  cors: NormalizedChannelCorsOptions | undefined,
  label: string,
  issues: string[],
): void {
  if (cors === undefined) return;
  for (const issue of validateNormalizedChannelCorsOptions(cors)) {
    issues.push(`${label} has invalid normalized CORS: ${issue}`);
  }
}

function equalCorsOptions(
  left: NormalizedChannelCorsOptions,
  right: NormalizedChannelCorsOptions,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalRouteBindings(left: CompiledModuleBinding, right: CompiledModuleBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireRouteBinding(
  route: CompiledChannelDefinition,
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
): CompiledModuleBinding {
  const binding = bindings[route.sourceId];
  if (binding === undefined) {
    throw new Error(`Channel route source "${route.sourceId}" has no compiled module binding.`);
  }
  return binding;
}

function throwRouteError(input: {
  readonly code: string;
  readonly message: string;
  readonly nodeId: string;
  readonly route: CompiledChannelDefinition;
  readonly related?: readonly {
    readonly label: string;
    readonly route: CompiledChannelDefinition;
  }[];
}): never {
  throw new ChannelRoutePlanningError({
    code: input.code,
    logicalPath: input.route.logicalPath,
    message: input.message,
    nodeId: input.nodeId,
    related: input.related?.map(({ label, route }) => ({
      label,
      logicalPath: route.logicalPath,
      nodeId: input.nodeId,
      sourceId: route.sourceId,
    })),
    severity: "error",
    sourceId: input.route.sourceId,
  });
}
