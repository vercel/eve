import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/paths.js";
import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = ".vercel/output/config.json";
const VERCEL_BUILD_OUTPUT_VERSION = 3;
const EVE_SERVICE_NAME = "eve";
const EVE_SERVICE_ROUTE_SRC = "^/eve/v1/(.*)$";
const EVE_SERVICE_ROUTE_PATH = "/eve/v1/$1";
const EVE_VERCEL_SERVICES_DIRECTORY = ".eve/vercel-services";

interface VercelServiceMount {
  readonly path?: string;
  readonly subdomain?: string;
}

interface VercelServiceConfig {
  readonly buildCommand?: string;
  readonly entrypoint?: string;
  readonly framework?: string;
  readonly mount?: string | VercelServiceMount;
  readonly routes?: readonly VercelRouteConfig[];
  readonly routePrefix?: string;
  readonly root?: string;
  readonly type?: string;
}

interface MutableGeneratedVercelServiceConfig {
  buildCommand: string;
  framework: "eve";
  routePrefix?: string;
  routes: readonly VercelRouteConfig[];
  root: string;
}

interface VercelNamedServiceConfig extends VercelServiceConfig {
  readonly name?: string;
}

type VercelServicesCollection =
  | Record<string, VercelServiceConfig>
  | readonly VercelNamedServiceConfig[];

interface VercelServiceRouteDestination {
  readonly service?: string;
  readonly type?: string;
}

interface VercelRequestPathTransform {
  readonly args: string;
  readonly op: "set";
  readonly type: "request.path";
}

interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly VercelRequestPathTransform[];
  readonly [key: string]: unknown;
}

interface VercelServicesConfig {
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: VercelServicesCollection;
  readonly [key: string]: unknown;
}

interface VercelOutputConfig extends VercelServicesConfig {
  readonly version?: number;
}

export interface EnsureVercelOutputConfigResult {
  readonly agents: readonly EnsureVercelOutputConfigAgentResult[];
}

export interface EnsureVercelOutputConfigAgentInput {
  readonly appRoot: string;
  readonly buildCommand: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly servicePrefix: string;
}

export interface EnsureVercelOutputConfigAgentResult {
  readonly name?: string;
  readonly servicePrefix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasServices(
  services: VercelServicesCollection | undefined,
): services is VercelServicesCollection {
  return services !== undefined && Object.keys(createServiceConfigRecord(services)).length > 0;
}

function isNamedServiceConfigArray(
  services: VercelServicesCollection,
): services is readonly VercelNamedServiceConfig[] {
  return Array.isArray(services);
}

function createServiceConfigRecord(
  services: VercelServicesCollection | undefined,
): Record<string, VercelServiceConfig> {
  if (services === undefined) {
    return {};
  }

  if (isNamedServiceConfigArray(services)) {
    const record: Record<string, VercelServiceConfig> = {};

    for (const service of services) {
      if (typeof service.name === "string" && service.name.trim().length > 0) {
        const { name, ...serviceConfig } = service;
        record[name] = serviceConfig;
      }
    }

    return record;
  }

  return services;
}

function resolveRelativeEntrypoint(fromRoot: string, toRoot: string): string {
  const relativePath = relative(fromRoot, toRoot);

  if (relativePath.length === 0) {
    return ".";
  }

  return relativePath.replaceAll("\\", "/");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createGeneratedServiceBuild(input: {
  readonly agent: EnsureVercelOutputConfigAgentInput;
  readonly hostOutputDirectory: string;
  readonly nextRoot: string;
  readonly serviceName: string;
}): {
  readonly buildCommand: string;
  readonly root: string;
  readonly rootDirectory: string;
} {
  const rootDirectory = join(input.nextRoot, EVE_VERCEL_SERVICES_DIRECTORY, input.serviceName);
  const outputDirectory = join(rootDirectory, ".vercel", "output");
  const workingDirectory = resolveRelativeEntrypoint(rootDirectory, input.agent.appRoot);
  const configuredOutputDirectory = resolveRelativeEntrypoint(input.agent.appRoot, outputDirectory);
  const configuredHostOutputDirectory = resolveRelativeEntrypoint(
    input.agent.appRoot,
    input.hostOutputDirectory,
  );

  return {
    buildCommand: `cd ${quoteShellArgument(workingDirectory)} && export ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(configuredOutputDirectory)} && export ${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(configuredHostOutputDirectory)} && ${input.agent.buildCommand}`,
    root: resolveRelativeEntrypoint(input.nextRoot, rootDirectory),
    rootDirectory,
  };
}

async function resolveVercelOutputConfigLocation(nextRoot: string): Promise<{
  readonly canWriteGeneratedOutput: boolean;
  readonly outputConfigPath: string;
  readonly projectRoot: string;
}> {
  const vercelDirectory = await findClosestLinkedVercelDirectory(nextRoot);
  const projectRoot = vercelDirectory === undefined ? nextRoot : dirname(vercelDirectory);
  const outputDirectory = await findClosestVercelOutputDirectory(nextRoot);

  if (outputDirectory !== undefined) {
    return {
      canWriteGeneratedOutput: true,
      outputConfigPath: join(outputDirectory, "config.json"),
      projectRoot,
    };
  }

  if (vercelDirectory !== undefined) {
    return {
      canWriteGeneratedOutput: true,
      outputConfigPath: join(vercelDirectory, "output", "config.json"),
      projectRoot,
    };
  }

  return {
    canWriteGeneratedOutput: Boolean(process.env.VERCEL),
    outputConfigPath: join(nextRoot, VERCEL_OUTPUT_CONFIG_FILE_NAME),
    projectRoot,
  };
}

function normalizeVercelServicesConfig(value: unknown, fileName: string): VercelServicesConfig {
  if (!isRecord(value)) {
    throw new Error(`${fileName} must contain a JSON object.`);
  }

  const services = value.services;

  if (
    services !== undefined &&
    !isRecord(services) &&
    !(
      Array.isArray(services) &&
      services.every(
        (service) =>
          isRecord(service) && typeof service.name === "string" && service.name.trim().length > 0,
      )
    )
  ) {
    throw new Error(`${fileName} services must be a JSON object or named service array.`);
  }

  const routes = value.routes;

  if (routes !== undefined && !Array.isArray(routes)) {
    throw new Error(`${fileName} routes must be an array.`);
  }

  return value as VercelServicesConfig;
}

async function readVercelServicesConfig(
  path: string,
  fileName: string,
): Promise<VercelServicesConfig> {
  try {
    return normalizeVercelServicesConfig(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      fileName,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function findServiceEntryByFramework(
  services: Record<string, VercelServiceConfig>,
  framework: string,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  return Object.entries(services)
    .map(([name, service]) => ({ name, service }))
    .find((entry) => entry.service.framework === framework);
}

function findServiceEntryByName(
  services: Record<string, VercelServiceConfig>,
  name: string,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  const service = services[name];
  return service === undefined ? undefined : { name, service };
}

function resolveServicePrefix(service: VercelServiceConfig | undefined): string | undefined {
  if (service === undefined) {
    return undefined;
  }

  if (typeof service.routePrefix === "string" && service.routePrefix.trim().length > 0) {
    return service.routePrefix.trim();
  }

  if (typeof service.mount === "string" && service.mount.trim().length > 0) {
    return service.mount.trim();
  }

  if (
    isRecord(service.mount) &&
    typeof service.mount.path === "string" &&
    service.mount.path.trim().length > 0
  ) {
    return service.mount.path.trim();
  }

  return undefined;
}

function resolveConfiguredServicePrefix(input: {
  readonly agent: EnsureVercelOutputConfigAgentInput;
  readonly services: Record<string, VercelServiceConfig>;
}): string {
  const configuredEveService = findConfiguredEveServiceEntry(input.services, input.agent)?.service;
  return resolveServicePrefix(configuredEveService) ?? input.agent.servicePrefix;
}

function findConfiguredEveServiceEntry(
  services: Record<string, VercelServiceConfig>,
  agent: EnsureVercelOutputConfigAgentInput,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  if (agent.name !== undefined) {
    const namedService = findServiceEntryByName(services, createEveServiceName(agent.name));
    if (namedService?.service.framework === "eve") {
      return namedService;
    }
  }

  return agent.name === undefined ? findServiceEntryByFramework(services, "eve") : undefined;
}

function assertRootServicesIncludeEve(input: {
  readonly agents: readonly EnsureVercelOutputConfigAgentInput[];
  readonly services: Record<string, VercelServiceConfig>;
}): readonly EnsureVercelOutputConfigAgentResult[] {
  const results: EnsureVercelOutputConfigAgentResult[] = [];

  for (const agent of input.agents) {
    const configuredEveService = findConfiguredEveServiceEntry(input.services, agent)?.service;

    if (configuredEveService === undefined) {
      throw new Error(
        `${VERCEL_JSON_FILE_NAME} already defines services, so withEve cannot add generated eve services through ${VERCEL_OUTPUT_CONFIG_FILE_NAME}. Add the eve service for ${agent.name ?? "the default agent"} to ${VERCEL_JSON_FILE_NAME}, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
      );
    }

    results.push({
      name: agent.name,
      servicePrefix: resolveServicePrefix(configuredEveService) ?? agent.servicePrefix,
    });
  }

  return results;
}

function createEveServiceRouteSrc(publicRoutePrefix: string): string {
  if (publicRoutePrefix.length === 0) {
    return EVE_SERVICE_ROUTE_SRC;
  }

  const normalizedPrefix = publicRoutePrefix.startsWith("/")
    ? publicRoutePrefix
    : `/${publicRoutePrefix}`;
  return `^${escapeRegExp(normalizedPrefix)}/eve/v1/(.*)$`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createEveServiceName(name: string | undefined): string {
  return name === undefined ? EVE_SERVICE_NAME : `${EVE_SERVICE_NAME}-${name}`;
}

function isEveServiceRoute(
  route: VercelRouteConfig,
  serviceName: string,
  routeSrc: string,
): boolean {
  const destination = route.destination;

  return (
    route.src === routeSrc &&
    isRecord(destination) &&
    destination.type === "service" &&
    destination.service === serviceName
  );
}

function createEveServiceRoute(serviceName: string, routeSrc: string): VercelRouteConfig {
  return {
    destination: {
      service: serviceName,
      type: "service",
    },
    src: routeSrc,
  };
}

function isEveServiceRequestPathRoute(route: VercelRouteConfig, routeSrc: string): boolean {
  return route.src === routeSrc;
}

function createEveServiceRequestPathRoute(routeSrc: string): VercelRouteConfig {
  return {
    src: routeSrc,
    transforms: [
      {
        args: EVE_SERVICE_ROUTE_PATH,
        op: "set",
        type: "request.path",
      },
    ],
  };
}

function insertEveServiceRequestPathRoute(
  routes: readonly VercelRouteConfig[] | undefined,
  routeSrc: string,
): readonly VercelRouteConfig[] {
  const existingRoutes = routes ?? [];
  const routesWithoutGeneratedRoute = existingRoutes.filter(
    (route) => !isEveServiceRequestPathRoute(route, routeSrc),
  );

  return [createEveServiceRequestPathRoute(routeSrc), ...routesWithoutGeneratedRoute];
}

function insertEveServiceRoutes(
  routes: readonly VercelRouteConfig[],
  eveRoutes: readonly {
    readonly routeSrc: string;
    readonly serviceName: string;
  }[],
): readonly VercelRouteConfig[] {
  const routesWithoutEveRoutes = routes.filter(
    (route) =>
      !eveRoutes.some((eveRoute) =>
        isEveServiceRoute(route, eveRoute.serviceName, eveRoute.routeSrc),
      ),
  );
  const filesystemRouteIndex = routesWithoutEveRoutes.findIndex(
    (route) => route.handle === "filesystem",
  );
  const nextEveRoutes = eveRoutes.map((eveRoute) =>
    createEveServiceRoute(eveRoute.serviceName, eveRoute.routeSrc),
  );

  if (filesystemRouteIndex === -1) {
    return [...nextEveRoutes, ...routesWithoutEveRoutes];
  }

  return [
    ...routesWithoutEveRoutes.slice(0, filesystemRouteIndex),
    ...nextEveRoutes,
    ...routesWithoutEveRoutes.slice(filesystemRouteIndex),
  ];
}

export async function ensureEveVercelOutputConfig(input: {
  readonly agents: readonly EnsureVercelOutputConfigAgentInput[];
  readonly nextRoot: string;
}): Promise<EnsureVercelOutputConfigResult> {
  const { canWriteGeneratedOutput, outputConfigPath, projectRoot } =
    await resolveVercelOutputConfigLocation(input.nextRoot);
  const rootVercelConfig = await readVercelServicesConfig(
    join(projectRoot, VERCEL_JSON_FILE_NAME),
    VERCEL_JSON_FILE_NAME,
  );
  const rootServices = rootVercelConfig.services;

  if (hasServices(rootServices)) {
    return {
      agents: assertRootServicesIncludeEve({
        agents: input.agents,
        services: createServiceConfigRecord(rootServices),
      }),
    };
  }

  const existingConfig = (await readVercelServicesConfig(
    outputConfigPath,
    VERCEL_OUTPUT_CONFIG_FILE_NAME,
  )) as VercelOutputConfig;
  const existingServices = createServiceConfigRecord(existingConfig.services);
  const agentResults = input.agents.map((agent) => ({
    name: agent.name,
    servicePrefix: resolveConfiguredServicePrefix({
      agent,
      services: existingServices,
    }),
  }));

  if (!canWriteGeneratedOutput) {
    return {
      agents: agentResults,
    };
  }

  const services: Record<string, VercelServiceConfig> = {
    ...existingServices,
  };
  const eveRoutes: {
    routeSrc: string;
    serviceName: string;
  }[] = [];

  for (const agent of input.agents) {
    const configuredEveServiceEntry = findConfiguredEveServiceEntry(existingServices, agent);
    const serviceName = configuredEveServiceEntry?.name ?? createEveServiceName(agent.name);
    const routeSrc = createEveServiceRouteSrc(agent.publicRoutePrefix);

    if (configuredEveServiceEntry === undefined) {
      const generatedServiceBuild = createGeneratedServiceBuild({
        agent,
        hostOutputDirectory: dirname(outputConfigPath),
        nextRoot: input.nextRoot,
        serviceName,
      });
      await mkdir(generatedServiceBuild.rootDirectory, { recursive: true });
      const serviceConfig: MutableGeneratedVercelServiceConfig = {
        buildCommand: generatedServiceBuild.buildCommand,
        framework: "eve",
        routes: insertEveServiceRequestPathRoute(undefined, routeSrc),
        root: generatedServiceBuild.root,
      };

      if (agent.publicRoutePrefix.length > 0) {
        serviceConfig.routePrefix = agent.publicRoutePrefix;
      }

      services[serviceName] = serviceConfig;
    } else {
      services[serviceName] = {
        ...configuredEveServiceEntry.service,
        routes: insertEveServiceRequestPathRoute(
          configuredEveServiceEntry.service.routes,
          routeSrc,
        ),
      };
    }

    eveRoutes.push({
      routeSrc,
      serviceName,
    });
  }

  const { services: _services, ...configWithoutLegacyServices } = existingConfig;
  const vercelConfig: VercelOutputConfig = {
    ...configWithoutLegacyServices,
    routes: insertEveServiceRoutes(existingConfig.routes ?? [], eveRoutes),
    services,
    version: VERCEL_BUILD_OUTPUT_VERSION,
  };

  if (JSON.stringify(existingConfig) !== JSON.stringify(vercelConfig)) {
    await mkdir(dirname(outputConfigPath), { recursive: true });
    await writeFile(outputConfigPath, `${JSON.stringify(vercelConfig, null, 2)}\n`);
  }

  return {
    agents: agentResults,
  };
}
