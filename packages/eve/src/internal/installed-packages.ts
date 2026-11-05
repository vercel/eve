import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** A package found on disk, or a declared dependency that isn't installed (empty `root`). */
export interface InstalledPackage {
  readonly name: string | undefined;
  readonly root: string;
}

/** The packages at `packageRoots` and every package they can load, as installed on disk. */
export function installedDependencyClosure(
  packageRoots: readonly string[],
): readonly InstalledPackage[] {
  const closure: InstalledPackage[] = [];
  const visitedRoots = new Set<string>();
  const pendingRoots = packageRoots.map(toCanonicalPath);
  for (let root = pendingRoots.pop(); root !== undefined; root = pendingRoots.pop()) {
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    const manifest = readPackageManifest(root);
    closure.push({ name: manifest.name, root });
    for (const dependency of manifest.dependencies) {
      const dependencyRoot = findInstalledDependencyRoot(dependency, root);
      if (dependencyRoot === undefined) {
        closure.push({ name: dependency, root: "" });
      } else {
        pendingRoots.push(dependencyRoot);
      }
    }
  }
  return closure;
}

/**
 * Whether a module path sits inside one of `packageRoots` or a package they can load. Builds the
 * closure once, on the first call, and caches each directory's answer.
 */
export function createInstalledPackageScope(
  packageRoots: readonly string[],
): (modulePath: string) => boolean {
  let scopeRoots: ReadonlySet<string> | undefined;
  const byDirectory = new Map<string, boolean>();
  return (modulePath) => {
    if (packageRoots.length === 0) return false;
    scopeRoots ??= new Set(
      installedDependencyClosure(packageRoots)
        .map((installed) => installed.root)
        .filter((root) => root !== ""),
    );
    const directory = dirname(toCanonicalPath(modulePath));
    let inScope = byDirectory.get(directory);
    if (inScope === undefined) {
      const packageRoot = installedPackageRoot(modulePath);
      inScope = packageRoot !== undefined && scopeRoots.has(packageRoot);
      byDirectory.set(directory, inScope);
    }
    return inScope;
  };
}

/** The nearest enclosing directory whose package.json names a package, skipping nested stubs. */
export function installedPackageRoot(filePath: string): string | undefined {
  let directory = dirname(toCanonicalPath(filePath));
  while (true) {
    if (readPackageManifest(directory).name !== undefined) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readPackageManifest(packageRoot: string): {
  readonly name: string | undefined;
  readonly dependencies: readonly string[];
} {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const dependencyNames = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap(
      (field) =>
        pkg[field] !== null && typeof pkg[field] === "object"
          ? Object.keys(pkg[field] as Record<string, unknown>)
          : [],
    );
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      dependencies: [...new Set(dependencyNames)],
    };
  } catch {
    return { name: undefined, dependencies: [] };
  }
}

function findInstalledDependencyRoot(dependency: string, fromRoot: string): string | undefined {
  const searchPaths = createRequire(join(fromRoot, "package.json")).resolve.paths(dependency) ?? [];
  const packageJsonPath = searchPaths
    .map((searchPath) => join(searchPath, dependency, "package.json"))
    .find(existsSync);
  return packageJsonPath === undefined ? undefined : toCanonicalPath(dirname(packageJsonPath));
}

// The native realpath also expands Windows 8.3 names, such as a temp directory's `RUNNER~1`, so
// package roots recorded here match the long-form module ids bundlers hand to plugins.
function toCanonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
