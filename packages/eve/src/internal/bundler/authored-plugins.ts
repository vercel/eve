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
  readonly packageRoot: string;
  readonly authoredSourceOnly?: boolean;
  readonly hostBundledPackageRoots?: readonly string[];
  readonly extensions?: readonly string[];
}

export function createAuthoredPlugins(input: AuthoredPluginsInput): Plugin[] {
  const authoredSourceOnly = input.authoredSourceOnly ?? false;
  const extensions = input.extensions ?? RESOLVE_EXTENSIONS;
  const scope = createInstalledPackageScope(input.hostBundledPackageRoots ?? []);
  const handlesInstalledModule = scope.includes;
  const importerFilter = authoredSourceOnly ? createAuthoredImporterFilter(scope) : undefined;
  return [
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

function createAuthoredImporterFilter(scope: InstalledPackageScope): FilterExpression {
  const outsideNodeModules = not(importerId(NODE_MODULES));
  const hostBundled = [
    ...importerInside(NODE_MODULES.source, scope.nodeModulesDirectories()),
    ...importerInside("^", scope.rootsOutsideNodeModules()),
  ];
  return hostBundled.length === 0 ? outsideNodeModules : or(outsideNodeModules, ...hostBundled);
}

function importerInside(prefix: string, directories: readonly string[]): FilterExpression[] {
  if (directories.length === 0) return [];
  const alternatives = directories.map(pathSource).join("|");
  return [importerId(new RegExp(String.raw`${prefix}(?:${alternatives})[\\/]`, "i"))];
}

export function resolveAuthoredTsConfigPath(packageRoot: string): string | false {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(packageRoot, fileName);
    if (existsSync(path)) {
      return path;
    }
  }
  return false;
}
