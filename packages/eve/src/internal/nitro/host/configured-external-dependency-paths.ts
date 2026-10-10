import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { resolveExternalDependencyEntry } from "#internal/nitro/host/extension-external-dependency-plugin.js";

interface PackageJson {
  readonly dependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
}

/**
 * Resolves configured externals through the app's runtime dependency graph.
 *
 * An isolated workspace can make a source package's dependencies invisible
 * from the app root. Walking each package's declared runtime dependencies
 * preserves the package boundary that Node uses when resolving the import.
 */
export function resolveConfiguredExternalDependencyPaths(
  appRoot: string,
  dependencies: readonly string[],
): Record<string, string> {
  const pending = new Set(dependencies);
  const resolvedPaths: Record<string, string> = {};
  const resolvedAppRoot = resolve(appRoot);
  const packageRoots = [
    existsSync(resolvedAppRoot) ? realpathSync(resolvedAppRoot) : resolvedAppRoot,
  ];
  const visitedPackageRoots = new Set<string>();

  while (packageRoots.length > 0 && pending.size > 0) {
    const packageRoot = packageRoots.shift();
    if (packageRoot === undefined || visitedPackageRoots.has(packageRoot)) {
      continue;
    }
    visitedPackageRoots.add(packageRoot);

    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = readPackageJson(packageJsonPath);
    if (packageJson === undefined) {
      continue;
    }

    for (const dependency of pending) {
      try {
        resolvedPaths[dependency] = resolveExternalDependencyEntry(dependency, packageJsonPath);
        pending.delete(dependency);
      } catch {}
    }

    for (const dependency of collectRuntimeDependencyNames(packageJson)) {
      try {
        const dependencyEntry = resolveExternalDependencyEntry(dependency, packageJsonPath);
        const dependencyRoot = findPackageRoot(dependencyEntry);
        if (dependencyRoot !== undefined && !visitedPackageRoots.has(dependencyRoot)) {
          packageRoots.push(dependencyRoot);
        }
      } catch {}
    }
  }

  return resolvedPaths;
}

function readPackageJson(path: string): PackageJson | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function collectRuntimeDependencyNames(packageJson: PackageJson): string[] {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ];
}

function findPackageRoot(entryPath: string): string | undefined {
  let directory = dirname(realpathSync(entryPath));
  const { root } = parse(directory);

  while (true) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }
    if (directory === root) {
      return undefined;
    }
    directory = dirname(directory);
  }
}
