import type { Nitro, NitroEventHandler } from "nitro/types";

export interface EmbeddedEveNitroRouteRequirement {
  readonly method?: string;
  readonly route: string;
  readonly virtualId?: string;
}

/** Resources eve needs one embedding Nitro host to execute. */
export interface EmbeddedEveNitroRequirements {
  readonly routes: readonly EmbeddedEveNitroRouteRequirement[];
  readonly schedules: boolean;
  readonly websocket: boolean;
}

export interface EmbeddedEveNitroInstallation {
  commit(): void;
  rollback(): void;
}

type InstallationState = "installing" | "installed";

const installationStates = new WeakMap<Nitro, InstallationState>();
const NITRO_ROUTE_PARAMETER_PATTERN = /(?<!\\):[\w-]+(\([^)]*\))?/gu;

function describeNitroHost(nitro: Nitro): string {
  return `preset ${JSON.stringify(nitro.options.preset)}, builder ${JSON.stringify(
    nitro.options.builder,
  )}, dev ${String(nitro.options.dev)}`;
}

function isProvenFullRuntimeHost(nitro: Nitro): boolean {
  return (
    (nitro.options.dev === true &&
      nitro.options.builder === "vite" &&
      nitro.options.preset === "nitro-dev") ||
    (nitro.options.dev === false && nitro.options.preset === "node-server")
  );
}

function methodsOverlap(
  existingMethod: NitroEventHandler["method"],
  requiredMethod: string | undefined,
): boolean {
  if (existingMethod === undefined || requiredMethod === undefined) {
    return true;
  }

  return existingMethod.toUpperCase() === requiredMethod.toUpperCase();
}

function canonicalizeNitroRouteShape(route: string): string {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  const withoutTrailingSlash =
    normalizedRoute.length > 1 && normalizedRoute.endsWith("/")
      ? normalizedRoute.slice(0, -1)
      : normalizedRoute;
  return withoutTrailingSlash.replace(NITRO_ROUTE_PARAMETER_PATTERN, ":_$1");
}

function findRouteCollision(
  handlers: readonly NitroEventHandler[],
  requirement: EmbeddedEveNitroRouteRequirement,
): NitroEventHandler | undefined {
  return handlers.find(
    (handler) =>
      canonicalizeNitroRouteShape(handler.route) ===
        canonicalizeNitroRouteShape(requirement.route) &&
      methodsOverlap(handler.method, requirement.method),
  );
}

function programmaticRouteHandlers(nitro: Nitro): NitroEventHandler[] {
  return Object.entries(nitro.options.routes).map(([route, handler]) =>
    typeof handler === "string" ? { handler, route } : { ...handler, route },
  );
}

function routeResourceKey(resource: {
  readonly handler: string;
  readonly method?: string;
  readonly route?: string;
}): string {
  return `${resource.handler}\0${resource.method?.toUpperCase() ?? ""}\0${resource.route ?? ""}`;
}

function handlersWithoutOwnedRoutes(
  handlers: readonly NitroEventHandler[],
  owned: readonly EmbeddedEveNitroRouteRequirement[],
): NitroEventHandler[] {
  const ownedCounts = new Map<string, number>();
  for (const resource of owned) {
    if (resource.virtualId === undefined) {
      continue;
    }
    const key = routeResourceKey({
      handler: resource.virtualId,
      method: resource.method,
      route: resource.route,
    });
    ownedCounts.set(key, (ownedCounts.get(key) ?? 0) + 1);
  }

  return handlers.filter((handler) => {
    const key = routeResourceKey(handler);
    const count = ownedCounts.get(key) ?? 0;
    if (count === 0) {
      return true;
    }
    ownedCounts.set(key, count - 1);
    return false;
  });
}

function assertNoRouteOrVirtualCollisions(
  nitro: Nitro,
  requirements: readonly EmbeddedEveNitroRouteRequirement[],
  input: {
    readonly handlers: readonly NitroEventHandler[];
    readonly permittedVirtualIds?: ReadonlySet<string>;
  },
): void {
  for (const requirement of requirements) {
    const collision = findRouteCollision(input.handlers, requirement);
    if (collision !== undefined) {
      throw new Error(
        `Embedded eve route ${requirement.method ?? "ALL"} ${requirement.route} conflicts with existing Nitro handler ${collision.handler}. Remove or remap the host handler before installing eve.`,
      );
    }

    if (
      requirement.virtualId !== undefined &&
      !input.permittedVirtualIds?.has(requirement.virtualId) &&
      Object.hasOwn(nitro.options.virtual, requirement.virtualId)
    ) {
      throw new Error(
        `Embedded eve virtual module ${requirement.virtualId} conflicts with an existing Nitro virtual module. Remove the host module before installing eve.`,
      );
    }
  }
}

/**
 * Claims one Nitro instance for an embedded eve installation.
 *
 * The caller commits only after setup succeeds and rolls back on failure so a
 * failed attempt does not permanently poison a host instance.
 */
export function beginEmbeddedEveNitroInstallation(nitro: Nitro): EmbeddedEveNitroInstallation {
  const state = installationStates.get(nitro);
  if (state !== undefined) {
    throw new Error(
      state === "installed"
        ? "eve is already installed in this Nitro host. Configure exactly one eveNitro() plugin."
        : "eve installation is already in progress for this Nitro host.",
    );
  }

  installationStates.set(nitro, "installing");
  let active = true;

  return {
    commit() {
      if (!active) {
        return;
      }
      installationStates.set(nitro, "installed");
      active = false;
    },
    rollback() {
      if (!active) {
        return;
      }
      installationStates.delete(nitro);
      active = false;
    },
  };
}

/**
 * Validates an embedding Nitro host before eve mutates any Nitro-owned state.
 */
export function validateEmbeddedEveNitroHost(
  nitro: Nitro,
  requirements: EmbeddedEveNitroRequirements,
): void {
  if (nitro.meta?.majorVersion !== 3) {
    throw new Error(
      `Embedded eve requires Nitro 3 (tested range >=3 <4); received ${nitro.meta?.version ?? "unknown Nitro version"}.`,
    );
  }

  if (nitro.options.static || nitro.options.serverEntry === false) {
    throw new Error(
      `Embedded eve requires a dynamic server runtime; ${describeNitroHost(nitro)} resolves to static or serverless-disabled output.`,
    );
  }

  if (!isProvenFullRuntimeHost(nitro)) {
    const unsupportedResources = [
      ...(requirements.schedules ? ["schedules"] : []),
      ...(requirements.websocket ? ["WebSocket channels"] : []),
    ];
    if (unsupportedResources.length > 0) {
      throw new Error(
        `Embedded eve cannot prove executable support for ${unsupportedResources.join(
          " and ",
        )} on ${describeNitroHost(
          nitro,
        )}. Use the production node-server preset or the Nitro Vite nitro-dev host, or remove those resources.`,
      );
    }
  }

  assertNoRouteOrVirtualCollisions(nitro, requirements.routes, {
    handlers: [
      ...programmaticRouteHandlers(nitro),
      ...nitro.options.handlers,
      ...(nitro.scannedHandlers ?? []),
    ],
  });
}

/**
 * Validates one live channel-route replacement without treating the currently
 * installed eve resources as host-owned collisions.
 */
export function validateEmbeddedEveNitroRouteReplacement(
  nitro: Nitro,
  input: {
    readonly next: readonly EmbeddedEveNitroRouteRequirement[];
    readonly previous: readonly EmbeddedEveNitroRouteRequirement[];
  },
): void {
  const hostHandlers = [
    ...programmaticRouteHandlers(nitro),
    ...handlersWithoutOwnedRoutes(nitro.options.handlers, input.previous),
    ...(nitro.scannedHandlers ?? []),
  ];
  const previousVirtualIds = new Set(
    input.previous.flatMap((resource) =>
      resource.virtualId === undefined ? [] : [resource.virtualId],
    ),
  );

  assertNoRouteOrVirtualCollisions(nitro, input.next, {
    handlers: hostHandlers,
    permittedVirtualIds: previousVirtualIds,
  });
}
