import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
        resolvedPaths[dependency] = createRequire(anchor).resolve(dependency);
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
