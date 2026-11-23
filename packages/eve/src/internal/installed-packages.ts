import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const NODE_MODULES_SEGMENT = "/node_modules/";

export interface InstalledPackage {
  readonly name: string | undefined;
  readonly root: string;
}

export interface InstalledDependencyClosureOptions {
  readonly includeOptional?: boolean;
}

export function installedDependencyClosure(
  packageRoots: readonly string[],
  options?: InstalledDependencyClosureOptions,
): readonly InstalledPackage[] {
  const includeOptional = options?.includeOptional ?? true;
  const closure: InstalledPackage[] = [];
  const visitedRoots = new Set<string>();
  const pendingRoots = packageRoots.map(toCanonicalPath);
  for (let root = pendingRoots.pop(); root !== undefined; root = pendingRoots.pop()) {
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    const manifest = readPackageManifest(root, includeOptional);
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

export interface InstalledPackageScope {
  readonly includes: (modulePath: string) => boolean;
  readonly nodeModulesDirectories: () => readonly string[];
  readonly rootsOutsideNodeModules: () => readonly string[];
}

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

export function installedPackageRoot(filePath: string): string | undefined {
  let directory = dirname(toCanonicalPath(filePath));
  while (true) {
    if (readPackageManifest(directory).name !== undefined) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readPackageManifest(
  packageRoot: string,
  includeOptional = true,
): {
  readonly name: string | undefined;
  readonly dependencies: readonly string[];
} {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const dependencyNames = [
      ...objectKeys(pkg.dependencies),
      ...(includeOptional ? objectKeys(pkg.optionalDependencies) : []),
      ...peerDependencyNames(pkg, includeOptional),
    ];
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      dependencies: [...new Set(dependencyNames)],
    };
  } catch {
    return { name: undefined, dependencies: [] };
  }
}

function objectKeys(value: unknown): readonly string[] {
  return value !== null && typeof value === "object"
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function peerDependencyNames(
  pkg: Record<string, unknown>,
  includeOptional: boolean,
): readonly string[] {
  const names = objectKeys(pkg.peerDependencies);
  if (includeOptional) return names;
  const meta =
    pkg.peerDependenciesMeta !== null && typeof pkg.peerDependenciesMeta === "object"
      ? (pkg.peerDependenciesMeta as Record<string, unknown>)
      : undefined;
  if (meta === undefined) return names;
  return names.filter((name) => {
    const entry = meta[name];
    return !(
      entry !== null &&
      typeof entry === "object" &&
      (entry as { optional?: unknown }).optional === true
    );
  });
}

function findInstalledDependencyRoot(dependency: string, fromRoot: string): string | undefined {
  const searchPaths = createRequire(join(fromRoot, "package.json")).resolve.paths(dependency) ?? [];
  const packageJsonPath = searchPaths
    .map((searchPath) => join(searchPath, dependency, "package.json"))
    .find(existsSync);
  return packageJsonPath === undefined ? undefined : toCanonicalPath(dirname(packageJsonPath));
}

function toCanonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
