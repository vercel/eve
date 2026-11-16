import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "rolldown";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";
import {
  type FilterExpression,
  importerId,
  not,
  or,
  pathSource,
} from "#internal/bundler/filters.js";
import {
  createInstalledPackageScope,
  type InstalledPackageScope,
} from "#internal/installed-packages.js";

const NODE_MODULES = /[\\/]node_modules[\\/]/;

export interface AuthoredPluginsInput {
  /** The authored package: asset imports stay inside it, and its tsconfig resolves aliases. */
  readonly packageRoot: string;
  /**
   * For builds that also bundle installed dependencies, the workflow driver
   * and the Nitro host: eve resolves imports from authored source only and
   * leaves dependency imports to the bundler.
   */
  readonly authoredSourceOnly?: boolean;
  /**
   * With `authoredSourceOnly`, installed packages that generated bundles imported and left for
   * this build. They and the packages they load keep the asset, extension, and package-local
   * tsconfig `paths` resolution that inlining them into those bundles would have applied.
   */
  readonly hostBundledPackageRoots?: readonly string[];
  readonly extensions?: readonly string[];
}

/**
 * How every eve build resolves authored source: authored module bundles,
 * extension distributions, the workflow driver, and the Nitro host. Callers
 * put their own plugins around this list, never inside it.
 */
export function createAuthoredPlugins(input: AuthoredPluginsInput): Plugin[] {
  const authoredSourceOnly = input.authoredSourceOnly ?? false;
  const extensions = input.extensions ?? RESOLVE_EXTENSIONS;
  const scope = createInstalledPackageScope(input.hostBundledPackageRoots ?? []);
  const handlesInstalledModule = scope.includes;
  const importerFilter = authoredSourceOnly ? createAuthoredImporterFilter(scope) : undefined;
  return [
    // First, so no other resolver claims an asset import before its package-root check.
    createAuthoredAssetImportPlugin({
      authoredSourceOnly,
      handlesInstalledModule,
      importerFilter,
      packageRoot: input.packageRoot,
    }),
    createAuthoredRelativeExtensionResolverPlugin({
      authoredSourceOnly,
      extensions,
      handlesInstalledModule,
      importerFilter,
    }),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: input.packageRoot,
      authoredSourceOnly,
      extensions,
      handlesInstalledModule,
      importerFilter,
    }),
  ];
}

/**
 * Admits every importer an `authoredSourceOnly` resolver accepts: those outside `node_modules`,
 * and those in a host-bundled package's directory. That is the package's directory below
 * `node_modules`, or its root when the package sits outside `node_modules`. The handlers still
 * make the exact checks. This only spares the call into JavaScript, which a specifier filter
 * alone makes for nearly every import of every dependency module.
 */
function createAuthoredImporterFilter(scope: InstalledPackageScope): FilterExpression {
  const outsideNodeModules = not(importerId(NODE_MODULES));
  const hostBundled = [
    ...importerInside(NODE_MODULES.source, scope.nodeModulesDirectories()),
    ...importerInside("^", scope.rootsOutsideNodeModules()),
  ];
  return hostBundled.length === 0 ? outsideNodeModules : or(outsideNodeModules, ...hostBundled);
}

/** Matches importers inside any of `directories`, each written after `prefix`. */
function importerInside(prefix: string, directories: readonly string[]): FilterExpression[] {
  // An empty group matches the empty string, which after `^` admits every POSIX path.
  if (directories.length === 0) return [];
  const alternatives = directories.map(pathSource).join("|");
  // Ignores case: on a case-insensitive filesystem an import can spell a directory its own way.
  return [importerId(new RegExp(String.raw`${prefix}(?:${alternatives})[\\/]`, "i"))];
}

/**
 * The one tsconfig every build of the authored package reads: its own
 * `tsconfig.json` or `jsconfig.json`. Sources in other workspace packages get
 * their own package's `paths` from {@link createAuthoredPlugins}.
 */
export function resolveAuthoredTsConfigPath(packageRoot: string): string | false {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(packageRoot, fileName);
    if (existsSync(path)) {
      return path;
    }
  }
  return false;
}
