import { resolve } from "node:path";

import {
  createEvePublicRoute,
  createEveRequestPathRoute,
  createEveServiceName,
  type EveVercelAgentTarget,
} from "#internal/vercel/eve-service-contribution.js";
import {
  createServiceConfigRecord,
  type VercelRouteConfig,
  type VercelServiceConfig,
  type VercelServicesCollection,
  type VercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";

export function resolveServicePrefix(service: VercelServiceConfig | undefined): string | undefined {
  if (typeof service?.routePrefix === "string" && service.routePrefix.trim().length > 0) {
    return service.routePrefix.trim();
  }
  if (typeof service?.mount === "string" && service.mount.trim().length > 0) {
    return service.mount.trim();
  }
  if (
    typeof service?.mount === "object" &&
    typeof service.mount.path === "string" &&
    service.mount.path.trim().length > 0
  ) {
    return service.mount.path.trim();
  }
  return undefined;
}

function parseLegacyServiceCollection(
  value: JsonValue | undefined,
): readonly VercelServiceConfig[] | undefined {
  if (value === undefined) return undefined;
  let entries: readonly JsonValue[];
  try {
    entries = Array.isArray(value) ? value : Object.values(parseJsonObject(value));
  } catch {
    return undefined;
  }
  return entries.flatMap((entry) => {
    try {
      return [parseJsonObject(entry) as VercelServiceConfig];
    } catch {
      return [];
    }
  });
}

function createServiceConfigList(
  services: VercelServicesCollection | undefined,
): readonly VercelServiceConfig[] | undefined {
  return services === undefined ? undefined : Object.values(createServiceConfigRecord(services));
}

function resolveServiceRoot(configRoot: string, service: VercelServiceConfig): string | undefined {
  const root = service.root ?? service.entrypoint;
  return typeof root === "string" && root.trim().length > 0 ? resolve(configRoot, root) : undefined;
}

function resolveServiceCollection(
  config: VercelServicesConfig,
): readonly VercelServiceConfig[] | undefined {
  return (
    parseLegacyServiceCollection(config.experimentalServices) ??
    parseLegacyServiceCollection(config.experimentalServicesV2) ??
    createServiceConfigList(config.services)
  );
}

/** Resolve the mounted prefix for the eve service matching an application root. */
export function resolveEveServicePrefixByRoot(input: {
  readonly appRoots: readonly string[];
  readonly config: VercelServicesConfig;
  readonly configRoot: string;
}): string | undefined {
  for (const service of resolveServiceCollection(input.config) ?? []) {
    const prefix = resolveServicePrefix(service);
    if (
      service.framework === "eve" &&
      prefix !== undefined &&
      prefix !== "/" &&
      input.appRoots.includes(resolveServiceRoot(input.configRoot, service) ?? "")
    ) {
      return prefix;
    }
  }
  return undefined;
}

export function findConfiguredEveServiceEntry(
  services: Record<string, VercelServiceConfig>,
  agent: EveVercelAgentTarget,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  if (agent.name !== undefined) {
    const name = createEveServiceName(agent.name);
    const service = services[name];
    return service?.framework === "eve" ? { name, service } : undefined;
  }
  const entry = Object.entries(services).find(([, service]) => service.framework === "eve");
  return entry === undefined ? undefined : { name: entry[0], service: entry[1] };
}

export function insertEveServiceRequestPathRoute(
  routes: readonly VercelRouteConfig[] | undefined,
  routeSrc: string,
): readonly VercelRouteConfig[] {
  return [
    createEveRequestPathRoute(routeSrc),
    ...(routes ?? []).filter((route) => route.src !== routeSrc),
  ];
}

export function insertEveServiceRoutes(
  routes: readonly VercelRouteConfig[],
  eveRoutes: readonly {
    readonly requestPath?: string;
    readonly routeSrc: string;
    readonly serviceName: string;
  }[],
): readonly VercelRouteConfig[] {
  const serviceNamesByRouteSource = new Map<string, Set<string>>();
  for (const eveRoute of eveRoutes) {
    const serviceNames = serviceNamesByRouteSource.get(eveRoute.routeSrc) ?? new Set<string>();
    serviceNames.add(eveRoute.serviceName);
    serviceNamesByRouteSource.set(eveRoute.routeSrc, serviceNames);
  }

  const retained = routes.filter((route) => {
    if (route.src === undefined) return true;

    const serviceNames = serviceNamesByRouteSource.get(route.src);
    if (serviceNames === undefined) return true;

    const destination = route.destination;
    const isGeneratedServiceRoute =
      typeof destination === "object" &&
      typeof destination.service === "string" &&
      destination.type === "service" &&
      serviceNames.has(destination.service);

    return route.transforms === undefined && !isGeneratedServiceRoute;
  });
  const generated = eveRoutes.flatMap(({ requestPath, routeSrc, serviceName }) => [
    ...(requestPath === undefined
      ? []
      : [
          {
            src: routeSrc,
            transforms: [{ args: requestPath, op: "set" as const, type: "request.path" as const }],
          },
        ]),
    createEvePublicRoute(serviceName, routeSrc),
  ]);
  const filesystemIndex = retained.findIndex((route) => route.handle === "filesystem");
  return filesystemIndex < 0
    ? [...generated, ...retained]
    : [...retained.slice(0, filesystemIndex), ...generated, ...retained.slice(filesystemIndex)];
}
