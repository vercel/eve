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

/** Resolve the mounted prefix for an eve service co-deployed with a host service. */
export function resolveCoDeployedEveServicePrefix(input: {
  readonly appRoots: readonly string[];
  readonly config: VercelServicesConfig;
  readonly configRoot: string;
}): string | undefined {
  const services =
    parseLegacyServiceCollection(input.config.experimentalServices) ??
    parseLegacyServiceCollection(input.config.experimentalServicesV2) ??
    createServiceConfigList(input.config.services);
  if (services === undefined || !services.some((service) => service.framework !== "eve")) {
    return undefined;
  }

  for (const service of services) {
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

function isEveServiceRoute(
  route: VercelRouteConfig,
  serviceName: string,
  routeSrc: string,
): boolean {
  const destination = route.destination;
  return (
    route.src === routeSrc &&
    typeof destination === "object" &&
    destination.type === "service" &&
    destination.service === serviceName
  );
}

export function insertEveServiceRoutes(
  routes: readonly VercelRouteConfig[],
  eveRoutes: readonly { readonly routeSrc: string; readonly serviceName: string }[],
): readonly VercelRouteConfig[] {
  const retained = routes.filter(
    (route) =>
      !eveRoutes.some(({ routeSrc, serviceName }) =>
        isEveServiceRoute(route, serviceName, routeSrc),
      ),
  );
  const generated = eveRoutes.map(({ routeSrc, serviceName }) =>
    createEvePublicRoute(serviceName, routeSrc),
  );
  const filesystemIndex = retained.findIndex((route) => route.handle === "filesystem");
  return filesystemIndex < 0
    ? [...generated, ...retained]
    : [...retained.slice(0, filesystemIndex), ...generated, ...retained.slice(filesystemIndex)];
}
