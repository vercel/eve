import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  parseTsConfigObject,
  readTextFileIfExists,
} from "#internal/application/tsconfig-dependencies.js";

/**
 * Resolves the local roots that a tsconfig's path aliases can resolve to.
 * Each alias target that lands on authored workspace source contributes the
 * owning package root (or the target directory itself when no package owns
 * it), so snapshot planning can copy the aliased source.
 */
export async function resolveLocalTsConfigPathTargetRoots(input: {
  readonly configPath: string;
  readonly sourceRoot: string;
}): Promise<string[]> {
  const source = await readTextFileIfExists(input.configPath);

  if (source === undefined) {
    return [];
  }

  const parsedConfig = parseTsConfigObject(source);
  const compilerOptions = isObjectRecord(parsedConfig?.compilerOptions)
    ? parsedConfig.compilerOptions
    : undefined;
  const paths = isObjectRecord(compilerOptions?.paths) ? compilerOptions.paths : undefined;

  if (compilerOptions === undefined || paths === undefined) {
    return [];
  }

  const baseDirectory =
    typeof compilerOptions.baseUrl === "string"
      ? resolve(dirname(input.configPath), compilerOptions.baseUrl)
      : dirname(input.configPath);
  const localRoots = new Set<string>();

  for (const targets of Object.values(paths)) {
    if (!Array.isArray(targets)) {
      continue;
    }

    for (const target of targets) {
      if (typeof target !== "string" || target.length === 0) {
        continue;
      }

      const localRoot = await resolveLocalTsConfigPathTargetRoot({
        baseDirectory,
        sourceRoot: input.sourceRoot,
        target,
      });

      if (localRoot !== undefined) {
        localRoots.add(localRoot);
      }
    }
  }

  return [...localRoots].sort((left, right) => left.localeCompare(right));
}

/** Resolves the nearest ancestor directory (bounded by the source root) that owns a package.json. */
export async function resolveNearestPackageRoot(
  path: string,
  sourceRoot: string,
): Promise<string | undefined> {
  let currentDirectory = resolve(path);

  try {
    const stats = await lstat(currentDirectory);

    if (!stats.isDirectory()) {
      currentDirectory = dirname(currentDirectory);
    }
  } catch {
    currentDirectory = dirname(currentDirectory);
  }

  while (isAuthoredSourcePath(currentDirectory, sourceRoot)) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }

  return undefined;
}

/** Returns whether a path is authored workspace source rather than installed dependency data. */
export function isAuthoredSourcePath(path: string, sourceRoot: string): boolean {
  if (!isPathInsideOrEqual(path, sourceRoot)) {
    return false;
  }

  const relativePath = relative(sourceRoot, path);

  return !relativePath.split(/[\\/]/).includes("node_modules");
}

export function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}

async function resolveLocalTsConfigPathTargetRoot(input: {
  readonly baseDirectory: string;
  readonly sourceRoot: string;
  readonly target: string;
}): Promise<string | undefined> {
  const hasWildcard = input.target.includes("*");
  const targetPrefix = hasWildcard
    ? input.target.slice(0, input.target.indexOf("*"))
    : input.target;

  if (targetPrefix.length === 0 || targetPrefix === "." || targetPrefix === "./") {
    return undefined;
  }

  const resolvedTarget = resolve(input.baseDirectory, targetPrefix);

  if (!isAuthoredSourcePath(resolvedTarget, input.sourceRoot)) {
    return undefined;
  }

  const existingTarget = await resolveExistingPathOrAncestor({
    path: resolvedTarget,
    stopDirectory: input.sourceRoot,
  });

  if (existingTarget === undefined) {
    return undefined;
  }

  const packageRoot = await resolveNearestPackageRoot(existingTarget, input.sourceRoot);

  if (packageRoot !== undefined && packageRoot !== input.sourceRoot) {
    return packageRoot;
  }

  if (hasWildcard) {
    return undefined;
  }

  return existingTarget === input.sourceRoot ? undefined : existingTarget;
}

async function resolveExistingPathOrAncestor(input: {
  readonly path: string;
  readonly stopDirectory: string;
}): Promise<string | undefined> {
  let currentPath = resolve(input.path);

  while (isAuthoredSourcePath(currentPath, input.stopDirectory)) {
    if (existsSync(currentPath)) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }

  return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
