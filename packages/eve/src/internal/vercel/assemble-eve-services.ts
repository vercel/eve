import {
  compileEveVercelService,
  type EveVercelAgentTarget,
  type EveVercelBuildTarget,
} from "#internal/vercel/eve-service-contribution.js";
import {
  findConfiguredEveServiceEntry,
  insertEveServiceRequestPathRoute,
  insertEveServiceRoutes,
} from "#internal/vercel/vercel-service-config-operations.js";
import type {
  VercelRouteConfig,
  VercelServiceConfig,
} from "#internal/vercel/vercel-services-config.js";

export interface EveVercelServiceTarget {
  readonly agent: EveVercelAgentTarget;
  readonly target: EveVercelBuildTarget;
}

export interface AssembledEveVercelServices {
  readonly rootDirectories: readonly string[];
  readonly routes: readonly VercelRouteConfig[];
  readonly services: Readonly<Record<string, VercelServiceConfig>>;
}

/** Merge eve agents into one Vercel service graph. */
export function assembleEveVercelServices(input: {
  readonly agents: readonly EveVercelServiceTarget[];
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: Readonly<Record<string, VercelServiceConfig>>;
}): AssembledEveVercelServices {
  const existingServices = input.services ?? {};
  const services: Record<string, VercelServiceConfig> = { ...existingServices };
  const rootDirectories: string[] = [];
  const eveRoutes: { routeSrc: string; serviceName: string }[] = [];

  for (const { agent, target } of input.agents) {
    const contribution = compileEveVercelService({ agent, target });
    const configured = findConfiguredEveServiceEntry(existingServices, agent);
    const serviceName = configured?.name ?? contribution.serviceName;

    if (configured === undefined) rootDirectories.push(contribution.rootDirectory);
    services[serviceName] =
      configured === undefined
        ? contribution.service
        : {
            ...configured.service,
            routes: insertEveServiceRequestPathRoute(
              configured.service.routes,
              contribution.routeSrc,
            ),
          };
    eveRoutes.push({ routeSrc: contribution.routeSrc, serviceName });
  }

  return {
    rootDirectories,
    routes: insertEveServiceRoutes(input.routes ?? [], eveRoutes),
    services,
  };
}
