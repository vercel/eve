import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import {
  findConfiguredEveServiceEntry,
  resolveServicePrefix,
} from "#internal/vercel/vercel-service-config-operations.js";
import {
  createServiceConfigRecord,
  hasServices,
  parseVercelServicesConfig,
  type VercelServiceConfig,
  type VercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";
import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = ".vercel/output/config.json";
const VERCEL_BUILD_OUTPUT_VERSION = 3;

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

async function readVercelServicesConfig(
  path: string,
  fileName: string,
): Promise<VercelServicesConfig> {
  try {
    return parseVercelServicesConfig(JSON.parse(await readFile(path, "utf8")) as unknown, fileName);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function resolveConfiguredServicePrefix(input: {
  readonly agent: EnsureVercelOutputConfigAgentInput;
  readonly services: Record<string, VercelServiceConfig>;
}): string {
  const configuredEveService = findConfiguredEveServiceEntry(input.services, input.agent)?.service;
  return resolveServicePrefix(configuredEveService) ?? input.agent.servicePrefix;
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

  const assembled = assembleEveVercelServices({
    agents: input.agents.map((agent) => ({
      agent,
      target: {
        hostOutputDirectory: dirname(outputConfigPath),
        projectRoot: input.nextRoot,
      },
    })),
    routes: existingConfig.routes,
    services: existingServices,
  });
  await Promise.all(assembled.rootDirectories.map((root) => mkdir(root, { recursive: true })));

  const { services: _services, ...configWithoutLegacyServices } = existingConfig;
  const vercelConfig: VercelOutputConfig = {
    ...configWithoutLegacyServices,
    routes: assembled.routes,
    services: assembled.services,
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
