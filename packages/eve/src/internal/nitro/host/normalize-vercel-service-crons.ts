import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { normalizePublicRoutePrefix } from "#shared/public-route-prefix.js";

const VERCEL_OUTPUT_CONFIG_FILE_NAME = "config.json";
const EVE_CRON_ROUTE_PREFIX = `${EVE_ROUTE_PREFIX}/cron/`;

interface VercelCronConfig extends Record<string, unknown> {
  readonly path: string;
  readonly schedule: string;
}

interface VercelOutputConfig extends Record<string, unknown> {
  readonly crons?: readonly VercelCronConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOutputConfig(source: string, configPath: string): VercelOutputConfig {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) {
    throw new Error(`Vercel Build Output config at "${configPath}" must contain a JSON object.`);
  }
  return value;
}

function readCronConfigs(
  config: VercelOutputConfig,
  configPath: string,
): readonly VercelCronConfig[] | undefined {
  if (config.crons === undefined) {
    return undefined;
  }
  if (!Array.isArray(config.crons)) {
    throw new Error(`Vercel Build Output config at "${configPath}" must contain a crons array.`);
  }

  return config.crons.map((cron, index) => {
    if (
      !isRecord(cron) ||
      typeof cron.path !== "string" ||
      !cron.path.startsWith("/") ||
      typeof cron.schedule !== "string" ||
      cron.schedule.trim().length === 0
    ) {
      throw new Error(
        `Vercel Build Output config at "${configPath}" contains an invalid cron at index ${index}.`,
      );
    }
    return cron as VercelCronConfig;
  });
}

function normalizeCronPath(
  cron: VercelCronConfig,
  publicRoutePrefix: string | undefined,
): VercelCronConfig {
  if (publicRoutePrefix === undefined || !cron.path.startsWith(EVE_CRON_ROUTE_PREFIX)) {
    return cron;
  }

  return {
    ...cron,
    path: `${publicRoutePrefix}${cron.path}`,
  };
}

function deduplicateCronConfigs(crons: readonly VercelCronConfig[]): readonly VercelCronConfig[] {
  const keys = new Set<string>();
  return crons.filter((cron) => {
    const key = `${cron.path}\0${cron.schedule}`;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
    return true;
  });
}

/**
 * Makes an eve service's cron paths addressable through its public Vercel
 * mount before the service Build Output is returned to Vercel for assembly.
 */
export async function normalizeVercelServiceCrons(input: {
  readonly publicRoutePrefix?: string;
  readonly serviceOutputDirectory: string;
}): Promise<void> {
  const configPath = join(input.serviceOutputDirectory, VERCEL_OUTPUT_CONFIG_FILE_NAME);
  const config = parseOutputConfig(await readFile(configPath, "utf8"), configPath);
  const crons = readCronConfigs(config, configPath);
  if (crons === undefined) {
    return;
  }

  const publicRoutePrefix = normalizePublicRoutePrefix(input.publicRoutePrefix);
  const normalizedCrons = deduplicateCronConfigs(
    crons.map((cron) => normalizeCronPath(cron, publicRoutePrefix)),
  );
  const nextConfig: VercelOutputConfig = {
    ...config,
    crons: normalizedCrons,
  };

  if (JSON.stringify(config) !== JSON.stringify(nextConfig)) {
    await atomicWriteFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }
}
