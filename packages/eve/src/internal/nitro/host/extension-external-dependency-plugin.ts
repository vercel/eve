import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

interface BundlerPluginShape {
  readonly name: string;
  resolveId(source: string): { external: true; id: string } | null;
}

interface ExtensionExternalDependencyMount {
  readonly externalDependencies: readonly string[];
  readonly sourceRoot: string;
}

/** Keeps extension-owned runtime packages external so Nitro can preserve their full package trees. */
export function createExtensionExternalDependencyPlugin(
  mounts: readonly ExtensionExternalDependencyMount[],
): BundlerPluginShape | null {
  const dependencyAnchors = collectDependencyAnchors(mounts);
  if (dependencyAnchors.size === 0) {
    return null;
  }

  return {
    name: "eve-extension-external-dependency",
    resolveId(source) {
      const dependency = [...dependencyAnchors.keys()].find(
        (packageName) => source === packageName || source.startsWith(`${packageName}/`),
      );
      if (dependency === undefined) {
        return null;
      }
      return { external: true, id: source };
    },
  };
}

/** Resolves package entries for Nitro's nft tracer from the mounted extension package. */
export function resolveExtensionExternalDependencyPaths(
  mounts: readonly ExtensionExternalDependencyMount[],
): Record<string, string> {
  const resolvedPaths: Record<string, string> = {};
  for (const [dependency, anchors] of collectDependencyAnchors(mounts)) {
    for (const anchor of anchors) {
      try {
        resolvedPaths[dependency] = resolveDependencyEntry(dependency, anchor);
        break;
      } catch {}
    }
    if (resolvedPaths[dependency] === undefined) {
      throw new Error(
        `Cannot resolve extension external dependency "${dependency}" from its mounted extension package.`,
      );
    }
  }
  return resolvedPaths;
}

function resolveDependencyEntry(dependency: string, anchor: string): string {
  const require = createRequire(anchor);
  try {
    return require.resolve(dependency);
  } catch (error) {
    const packageJsonPath = require.resolve
      .paths(dependency)
      ?.map((searchPath) => join(searchPath, dependency, "package.json"))
      .find(existsSync);
    if (packageJsonPath === undefined) {
      throw error;
    }

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      exports?: unknown;
      main?: unknown;
      module?: unknown;
    };
    const entry =
      resolveImportExport(pkg.exports) ?? stringValue(pkg.module) ?? stringValue(pkg.main);
    if (entry === undefined) {
      throw error;
    }
    return resolve(dirname(packageJsonPath), entry);
  }
}

function resolveImportExport(exports: unknown): string | undefined {
  if (typeof exports === "string") {
    return exports;
  }
  if (Array.isArray(exports)) {
    return exports.map(resolveImportExport).find((entry) => entry !== undefined);
  }
  if (exports === null || typeof exports !== "object") {
    return undefined;
  }

  const conditions = exports as Record<string, unknown>;
  if ("." in conditions) {
    return resolveImportExport(conditions["."]);
  }
  for (const condition of ["node", "import", "default"]) {
    const entry = resolveImportExport(conditions[condition]);
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collectDependencyAnchors(
  mounts: readonly ExtensionExternalDependencyMount[],
): Map<string, string[]> {
  const dependencyAnchors = new Map<string, string[]>();
  for (const mount of mounts) {
    for (const dependency of mount.externalDependencies) {
      const anchors = dependencyAnchors.get(dependency) ?? [];
      anchors.push(join(realpathSync(mount.sourceRoot), "_manifest.json"));
      dependencyAnchors.set(dependency, anchors);
    }
  }
  return dependencyAnchors;
}
