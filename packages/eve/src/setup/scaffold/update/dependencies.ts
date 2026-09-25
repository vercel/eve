import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { patchPackageJson } from "./package-json.js";

export interface EnsurePackageDependenciesOptions {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly projectRoot: string;
}

export interface PackageDependencyMutation {
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly path: string;
  readonly scripts: readonly string[];
}

/** Adds missing or outdated runtime dependencies to an existing package.json. */
export async function ensurePackageDependencies(
  options: EnsurePackageDependenciesOptions,
): Promise<readonly PackageDependencyMutation[]> {
  const packageJsonPath = join(options.projectRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const current = isRecord(parsed) && isRecord(parsed.dependencies) ? parsed.dependencies : {};
  const missing = Object.fromEntries(
    Object.entries(options.dependencies).filter(([name, version]) => current[name] !== version),
  );
  const names = Object.keys(missing);
  if (names.length === 0) return [];

  await patchPackageJson(packageJsonPath, { dependencies: missing });
  return [
    {
      dependencies: names,
      devDependencies: [],
      path: packageJsonPath,
      scripts: [],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
