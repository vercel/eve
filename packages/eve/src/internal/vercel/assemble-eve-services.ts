import { toVercelRelativePath } from "#internal/vercel/build-command.js";
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
import { resolveInstalledEveVersion } from "#shared/resolve-eve-version.js";

interface EveVercelServiceTarget {
  readonly agent: EveVercelAgentTarget;
  readonly target: EveVercelBuildTarget;
}

interface AssembledEveVercelServices {
  readonly rootDirectories: readonly string[];
  readonly routes: readonly VercelRouteConfig[];
  readonly services: Readonly<Record<string, VercelServiceConfig>>;
}

export function assertSingleEveVersion(
  agents: readonly EveVercelServiceTarget[],
  resolveVersion: (root: string) => string | undefined = resolveInstalledEveVersion,
): void {
  const rootsByVersion = new Map<string, string[]>();
  const roots = new Set(agents.flatMap(({ agent, target }) => [target.projectRoot, agent.appRoot]));

  for (const root of roots) {
    const version = resolveVersion(root);
    if (version === undefined) continue;
    rootsByVersion.set(version, [...(rootsByVersion.get(version) ?? []), root]);
  }
  if (rootsByVersion.size <= 1) return;

  const projectRoot = agents[0]!.target.projectRoot;
  const found = [...rootsByVersion]
    .map(
      ([version, versionRoots]) =>
        `eve@${version} in ${versionRoots.map((root) => toVercelRelativePath(projectRoot, root)).join(", ")}`,
    )
    .join("; ");
  throw new Error(
    `Every eve agent in one Vercel deployment must resolve the same eve version, found ${found}. The agents share the deployment's Workflow runs, and a run replayed by a different eve version fails with CORRUPTED_EVENT_LOG. Install a single eve version for the project, for example by declaring eve only in the root package.json.`,
  );
}

export function assembleEveVercelServices(input: {
  readonly agents: readonly EveVercelServiceTarget[];
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: Readonly<Record<string, VercelServiceConfig>>;
}): AssembledEveVercelServices {
  const existingServices = input.services ?? {};
  const services: Record<string, VercelServiceConfig> = { ...existingServices };
  const rootDirectories: string[] = [];
  const eveRoutes: { routeSrc: string; serviceName: string }[] = [];

  assertSingleEveVersion(input.agents);

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
    if (contribution.homeRouteSrc !== undefined) {
      eveRoutes.push({ routeSrc: contribution.homeRouteSrc, serviceName });
    }
  }

  return {
    rootDirectories,
    routes: insertEveServiceRoutes(input.routes ?? [], eveRoutes),
    services,
  };
}
