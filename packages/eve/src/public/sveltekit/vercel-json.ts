import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { createEveVercelRewrite, type EveVercelRewrite } from "./routing.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_JSON_SCHEMA = "https://openapi.vercel.sh/vercel.json";

interface VercelServiceConfig {
  readonly buildCommand?: string;
  readonly entrypoint: string;
  readonly framework: string;
  readonly routePrefix: string;
}

interface VercelJsonConfig {
  readonly $schema?: string;
  readonly experimentalServices?: Record<string, VercelServiceConfig>;
  readonly rewrites?: readonly EveVercelRewrite[];
  readonly [key: string]: unknown;
}

export interface EnsureVercelJsonResult {
  readonly servicePrefix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveRelativeEntrypoint(fromRoot: string, toRoot: string): string {
  const relativePath = relative(fromRoot, toRoot);
  return relativePath.length === 0 ? "." : relativePath.replaceAll("\\", "/");
}

function normalizeVercelJsonConfig(value: unknown): VercelJsonConfig {
  if (!isRecord(value)) {
    throw new Error(`${VERCEL_JSON_FILE_NAME} must contain a JSON object.`);
  }

  const experimentalServices = value.experimentalServices;
  if (experimentalServices !== undefined && !isRecord(experimentalServices)) {
    throw new Error(`${VERCEL_JSON_FILE_NAME} experimentalServices must be a JSON object.`);
  }

  const rewrites = value.rewrites;
  if (rewrites !== undefined && !Array.isArray(rewrites)) {
    throw new Error(`${VERCEL_JSON_FILE_NAME} rewrites must be an array.`);
  }

  return value as VercelJsonConfig;
}

async function readVercelJsonConfig(path: string): Promise<VercelJsonConfig> {
  try {
    return normalizeVercelJsonConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
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

function hasRewrite(rewrites: readonly EveVercelRewrite[], rewrite: EveVercelRewrite): boolean {
  return rewrites.some(
    (existing) =>
      existing.source === rewrite.source && existing.destination === rewrite.destination,
  );
}

/**
 * Ensure `vercel.json` declares the SvelteKit web service and the eve agent
 * service so a Vercel deployment ships both from one project.
 *
 * Existing services are preserved untouched; an already-configured eve
 * service's `routePrefix` wins over {@link input.servicePrefix}. The file is
 * only rewritten when the resulting config differs from what is on disk.
 */
export async function ensureEveVercelJson(input: {
  readonly appRoot: string;
  readonly eveBuildCommand: string;
  readonly servicePrefix: string;
  readonly svelteKitRoot: string;
}): Promise<EnsureVercelJsonResult> {
  const vercelJsonPath = join(input.svelteKitRoot, VERCEL_JSON_FILE_NAME);
  const existingConfig = await readVercelJsonConfig(vercelJsonPath);
  const svelteKitEntrypoint = ".";
  const eveEntrypoint = resolveRelativeEntrypoint(input.svelteKitRoot, input.appRoot);
  const existingServices = existingConfig.experimentalServices ?? {};
  const configuredEveService = findServiceByFramework(existingServices, "eve");
  const configuredSvelteKitService = findServiceByFramework(existingServices, "sveltekit");
  const servicePrefix = configuredEveService?.routePrefix ?? input.servicePrefix;
  const experimentalServices: Record<string, VercelServiceConfig> = { ...existingServices };

  if (configuredSvelteKitService === undefined) {
    experimentalServices.web = {
      entrypoint: svelteKitEntrypoint,
      framework: "sveltekit",
      routePrefix: "/",
    };
  }

  if (configuredEveService === undefined) {
    experimentalServices.eve = {
      buildCommand: input.eveBuildCommand,
      entrypoint: eveEntrypoint,
      framework: "eve",
      routePrefix: servicePrefix,
    };
  }

  const rewrite = createEveVercelRewrite(servicePrefix);
  const rewrites = existingConfig.rewrites ?? [];
  const vercelConfig: VercelJsonConfig = {
    ...existingConfig,
    $schema: existingConfig.$schema ?? VERCEL_JSON_SCHEMA,
    experimentalServices,
    rewrites: hasRewrite(rewrites, rewrite) ? rewrites : [rewrite, ...rewrites],
  };

  if (JSON.stringify(existingConfig) !== JSON.stringify(vercelConfig)) {
    await writeFile(vercelJsonPath, `${JSON.stringify(vercelConfig, null, 2)}\n`);
  }

  return { servicePrefix };
}
