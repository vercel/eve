import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const NODE_MODULES_SEGMENT = "/node_modules/";

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

/** The packages at `packageRoots` and every package they can load. */
export interface InstalledPackageScope {
  /** Whether a module path sits inside one of the packages. Caches each directory's answer. */
  readonly includes: (modulePath: string) => boolean;
  /**
   * Each package's directory below `node_modules`, such as `@ai-sdk/openai`. It is where the
   * package is installed, which an npm alias makes differ from the package's name. A module of
   * such a package has it in its path, by its real path and through a link of the same name.
   * Packages outside `node_modules`, such as linked workspace packages, have none.
   */
  readonly nodeModulesDirectories: () => readonly string[];
  /**
   * The roots of the packages outside `node_modules`. A module of such a package can still have
   * `node_modules` in its path: a directory there that names no package belongs to the package.
   */
  readonly rootsOutsideNodeModules: () => readonly string[];
}

/** Builds the closure once, on first use. */
export function createInstalledPackageScope(
  packageRoots: readonly string[],
): InstalledPackageScope {
  let scopeRoots: ReadonlySet<string> | undefined;
  const roots = (): ReadonlySet<string> =>
    (scopeRoots ??= new Set(
      installedDependencyClosure(packageRoots)
        .map((installed) => installed.root)
        .filter((root) => root !== ""),
    ));
  const byDirectory = new Map<string, boolean>();
  return {
    includes(modulePath) {
      if (packageRoots.length === 0) return false;
      const directory = dirname(toCanonicalPath(modulePath));
      let inScope = byDirectory.get(directory);
      if (inScope === undefined) {
        const packageRoot = installedPackageRoot(modulePath);
        inScope = packageRoot !== undefined && roots().has(packageRoot);
        byDirectory.set(directory, inScope);
      }
      return inScope;
    },
    nodeModulesDirectories() {
      const directories = new Set<string>();
      for (const root of roots()) {
        const path = root.replaceAll("\\", "/");
        const index = path.lastIndexOf(NODE_MODULES_SEGMENT);
        if (index !== -1) directories.add(path.slice(index + NODE_MODULES_SEGMENT.length));
      }
      return [...directories];
    },
    rootsOutsideNodeModules() {
      return [...roots()].filter(
        (root) => !root.replaceAll("\\", "/").includes(NODE_MODULES_SEGMENT),
      );
    },
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
