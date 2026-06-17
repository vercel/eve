import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = ".vercel/output/config.json";
const VERCEL_BUILD_OUTPUT_VERSION = 3;

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
  readonly type?: string;
}

interface VercelServicesConfig {
  readonly experimentalServices?: Record<string, VercelServiceConfig>;
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
    canWriteGeneratedOutput: false,
    outputConfigPath: join(nextRoot, VERCEL_OUTPUT_CONFIG_FILE_NAME),
    projectRoot,
  };
}

function normalizeVercelServicesConfig(value: unknown, fileName: string): VercelServicesConfig {
  if (!isRecord(value)) {
    throw new Error(`${fileName} must contain a JSON object.`);
  }

  const experimentalServices = value.experimentalServices;

  if (experimentalServices !== undefined && !isRecord(experimentalServices)) {
    throw new Error(`${fileName} experimentalServices must be a JSON object.`);
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
  return Object.values(services).find((service) => service.framework === framework);
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

function assertRootServicesAreComplete(input: {
  readonly services: Record<string, VercelServiceConfig>;
  readonly servicePrefix: string;
}): string {
  const configuredEveService = findServiceByFramework(input.services, "eve");
  const configuredNextService = findServiceByFramework(input.services, "nextjs");

  if (configuredEveService !== undefined && configuredNextService !== undefined) {
    return resolveServicePrefix(configuredEveService) ?? input.servicePrefix;
  }

  throw new Error(
    `${VERCEL_JSON_FILE_NAME} already defines experimentalServices, so withEve cannot add generated services through ${VERCEL_OUTPUT_CONFIG_FILE_NAME}. Add both the Next.js and eve services to ${VERCEL_JSON_FILE_NAME}, or remove experimentalServices from ${VERCEL_JSON_FILE_NAME}.`,
  );
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
  const rootServices = rootVercelConfig.experimentalServices;

  if (hasServices(rootServices)) {
    return {
      servicePrefix: assertRootServicesAreComplete({
        services: rootServices,
        servicePrefix: input.servicePrefix,
      }),
    };
  }

  const existingConfig = (await readVercelServicesConfig(
    outputConfigPath,
    VERCEL_OUTPUT_CONFIG_FILE_NAME,
  )) as VercelOutputConfig;
  const nextEntrypoint = ".";
  const eveEntrypoint = resolveRelativeEntrypoint(input.nextRoot, input.appRoot);
  const existingServices = existingConfig.experimentalServices ?? {};
  const configuredEveService = findServiceByFramework(existingServices, "eve");
  const configuredNextService = findServiceByFramework(existingServices, "nextjs");
  const servicePrefix = resolveConfiguredServicePrefix({
    services: existingServices,
    servicePrefix: input.servicePrefix,
  });

  if (!canWriteGeneratedOutput) {
    return {
      servicePrefix,
    };
  }

  const experimentalServices: Record<string, VercelServiceConfig> = {
    ...existingServices,
  };

  if (configuredNextService === undefined) {
    experimentalServices.web = {
      entrypoint: nextEntrypoint,
      framework: "nextjs",
      mount: "/",
      type: "web",
    };
  }

  if (configuredEveService === undefined) {
    experimentalServices.eve = {
      buildCommand: input.eveBuildCommand,
      entrypoint: eveEntrypoint,
      framework: "eve",
      mount: servicePrefix,
      type: "web",
    };
  }

  const vercelConfig: VercelOutputConfig = {
    ...existingConfig,
    version: VERCEL_BUILD_OUTPUT_VERSION,
    experimentalServices,
  };

  if (JSON.stringify(existingConfig) !== JSON.stringify(vercelConfig)) {
    await mkdir(dirname(outputConfigPath), { recursive: true });
    await writeFile(outputConfigPath, `${JSON.stringify(vercelConfig, null, 2)}\n`);
  }

  return {
    servicePrefix,
  };
}
