import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = ".vercel/output/config.json";
const VERCEL_BUILD_OUTPUT_VERSION = 3;
const EVE_SERVICE_NAME = "eve";
const EVE_SERVICE_ROUTE_SRC = "^/eve/v1/(.*)$";

interface VercelServiceMount {
  readonly path?: string;
  readonly subdomain?: string;
}

interface VercelServiceConfig {
  readonly buildCommand?: string;
  readonly entrypoint?: string;
  readonly framework?: string;
  readonly mount?: string | VercelServiceMount;
  readonly routePrefix?: string;
  readonly root?: string;
  readonly type?: string;
}

interface VercelServiceRouteDestination {
  readonly service?: string;
  readonly type?: string;
}

interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly [key: string]: unknown;
}

interface VercelServicesConfig {
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: Record<string, VercelServiceConfig>;
  readonly [key: string]: unknown;
}

interface VercelOutputConfig extends VercelServicesConfig {
  readonly version?: number;
}

export interface EnsureVercelOutputConfigResult {
  readonly servicePrefix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasServices(
  services: Record<string, VercelServiceConfig> | undefined,
): services is Record<string, VercelServiceConfig> {
  return services !== undefined && Object.keys(services).length > 0;
}

function resolveRelativeEntrypoint(fromRoot: string, toRoot: string): string {
  const relativePath = relative(fromRoot, toRoot);

  if (relativePath.length === 0) {
    return ".";
  }

  return relativePath.replaceAll("\\", "/");
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

  if (services !== undefined && !isRecord(services)) {
    throw new Error(`${fileName} services must be a JSON object.`);
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

function findServiceByFramework(
  services: Record<string, VercelServiceConfig>,
  framework: string,
): VercelServiceConfig | undefined {
  return findServiceEntryByFramework(services, framework)?.service;
}

function findServiceEntryByFramework(
  services: Record<string, VercelServiceConfig>,
  framework: string,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  return Object.entries(services)
    .map(([name, service]) => ({ name, service }))
    .find((entry) => entry.service.framework === framework);
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
  readonly services: Record<string, VercelServiceConfig>;
  readonly servicePrefix: string;
}): string {
  const configuredEveService = findServiceByFramework(input.services, "eve");
  return resolveServicePrefix(configuredEveService) ?? input.servicePrefix;
}

function assertRootServicesIncludeEve(input: {
  readonly services: Record<string, VercelServiceConfig>;
  readonly servicePrefix: string;
}): string {
  const configuredEveService = findServiceByFramework(input.services, "eve");

  if (configuredEveService !== undefined) {
    return resolveServicePrefix(configuredEveService) ?? input.servicePrefix;
  }

  throw new Error(
    `${VERCEL_JSON_FILE_NAME} already defines services, so withEve cannot add a generated eve service through ${VERCEL_OUTPUT_CONFIG_FILE_NAME}. Add the eve service to ${VERCEL_JSON_FILE_NAME}, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
  );
}

function isEveServiceRoute(route: VercelRouteConfig, serviceName: string): boolean {
  const destination = route.destination;

  return (
    route.src === EVE_SERVICE_ROUTE_SRC &&
    isRecord(destination) &&
    destination.type === "service" &&
    destination.service === serviceName
  );
}

function createEveServiceRoute(serviceName: string): VercelRouteConfig {
  return {
    destination: {
      service: serviceName,
      type: "service",
    },
    src: EVE_SERVICE_ROUTE_SRC,
  };
}

function insertEveServiceRoute(
  routes: readonly VercelRouteConfig[],
  serviceName: string,
): readonly VercelRouteConfig[] {
  const existingRoute = routes.find((route) => isEveServiceRoute(route, serviceName));
  const routesWithoutEveRoute = routes.filter((route) => !isEveServiceRoute(route, serviceName));
  const filesystemRouteIndex = routesWithoutEveRoute.findIndex(
    (route) => route.handle === "filesystem",
  );
  const eveRoute = existingRoute ?? createEveServiceRoute(serviceName);

  if (filesystemRouteIndex === -1) {
    return [eveRoute, ...routesWithoutEveRoute];
  }

  return [
    ...routesWithoutEveRoute.slice(0, filesystemRouteIndex),
    eveRoute,
    ...routesWithoutEveRoute.slice(filesystemRouteIndex),
  ];
}

export async function ensureEveVercelOutputConfig(input: {
  readonly appRoot: string;
  readonly eveBuildCommand: string;
  readonly nextRoot: string;
  readonly servicePrefix: string;
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
      servicePrefix: assertRootServicesIncludeEve({
        services: rootServices,
        servicePrefix: input.servicePrefix,
      }),
    };
  }

  const existingConfig = (await readVercelServicesConfig(
    outputConfigPath,
    VERCEL_OUTPUT_CONFIG_FILE_NAME,
  )) as VercelOutputConfig;
  const eveEntrypoint = resolveRelativeEntrypoint(input.nextRoot, input.appRoot);
  const existingServices = existingConfig.services ?? {};
  const configuredEveServiceEntry = findServiceEntryByFramework(existingServices, "eve");
  const servicePrefix = resolveConfiguredServicePrefix({
    services: existingServices,
    servicePrefix: input.servicePrefix,
  });

  if (!canWriteGeneratedOutput) {
    return {
      servicePrefix,
    };
  }

  const services: Record<string, VercelServiceConfig> = {
    ...existingServices,
  };
  let eveServiceName = configuredEveServiceEntry?.name ?? EVE_SERVICE_NAME;

  if (configuredEveServiceEntry === undefined) {
    services[EVE_SERVICE_NAME] = {
      buildCommand: input.eveBuildCommand,
      entrypoint: "package.json",
      framework: "eve",
      root: eveEntrypoint,
    };
    eveServiceName = EVE_SERVICE_NAME;
  }

  const { services: _services, ...configWithoutLegacyServices } = existingConfig;
  const vercelConfig: VercelOutputConfig = {
    ...configWithoutLegacyServices,
    routes: insertEveServiceRoute(existingConfig.routes ?? [], eveServiceName),
    services,
    version: VERCEL_BUILD_OUTPUT_VERSION,
  };

  if (JSON.stringify(existingConfig) !== JSON.stringify(vercelConfig)) {
    await mkdir(dirname(outputConfigPath), { recursive: true });
    await writeFile(outputConfigPath, `${JSON.stringify(vercelConfig, null, 2)}\n`);
  }

  return {
    servicePrefix,
  };
}
