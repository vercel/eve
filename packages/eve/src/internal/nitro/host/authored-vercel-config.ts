import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VERCEL_CONFIG_FILENAMES = ["vercel.json", "vercel.ts", "vercel.mts"] as const;

interface AuthoredVercelConfig {
  readonly git?: unknown;
}

type VercelBuildOutputConfig = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function findAuthoredVercelConfigPath(appRoot: string): Promise<string | undefined> {
  for (const filename of VERCEL_CONFIG_FILENAMES) {
    const path = join(appRoot, filename);

    if (await pathExists(path)) {
      return path;
    }
  }

  return undefined;
}

function normalizeAuthoredVercelConfig(value: unknown, configPath: string): AuthoredVercelConfig {
  if (!isRecord(value)) {
    throw new Error(`${configPath} must export a Vercel config object.`);
  }

  return value;
}

async function loadAuthoredVercelConfig(
  configPath: string,
): Promise<AuthoredVercelConfig | undefined> {
  if (configPath.endsWith(".json")) {
    return normalizeAuthoredVercelConfig(
      JSON.parse(await readFile(configPath, "utf8")) as unknown,
      configPath,
    );
  }

  const module = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  const config = module.config ?? module.default;

  if (config === undefined) {
    return undefined;
  }

  return normalizeAuthoredVercelConfig(config, configPath);
}

/**
 * Nitro owns Build Output routing and function config, but authored Vercel Git
 * policy is project-level deployment behavior. Preserve it so Vercel can honor
 * settings such as `git.deploymentEnabled` for eve framework output.
 */
export async function mergeAuthoredVercelGitConfigIntoBuildOutput(input: {
  readonly appRoot: string;
  readonly outputDir: string;
}): Promise<void> {
  const configPath = await findAuthoredVercelConfigPath(input.appRoot);

  if (configPath === undefined) {
    return;
  }

  const authoredConfig = await loadAuthoredVercelConfig(configPath);

  if (authoredConfig?.git === undefined) {
    return;
  }

  const outputConfigPath = join(input.outputDir, "config.json");
  const outputConfig = JSON.parse(await readFile(outputConfigPath, "utf8")) as unknown;

  if (!isRecord(outputConfig)) {
    throw new Error(`${outputConfigPath} must contain a JSON object.`);
  }

  const nextConfig: VercelBuildOutputConfig = {
    ...outputConfig,
    git: outputConfig.git ?? authoredConfig.git,
  };

  if (JSON.stringify(outputConfig) !== JSON.stringify(nextConfig)) {
    await writeFile(outputConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }
}
