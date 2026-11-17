import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "rolldown";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";
import { createInstalledPackageScope } from "#internal/installed-packages.js";

export interface AuthoredPluginsInput {
  readonly packageRoot: string;
  readonly authoredSourceOnly?: boolean;
  readonly hostBundledPackageRoots?: readonly string[];
  readonly extensions?: readonly string[];
}

export function createAuthoredPlugins(input: AuthoredPluginsInput): Plugin[] {
  const authoredSourceOnly = input.authoredSourceOnly ?? false;
  const extensions = input.extensions ?? RESOLVE_EXTENSIONS;
  const handlesInstalledModule = createInstalledPackageScope(input.hostBundledPackageRoots ?? []);
  return [
    createAuthoredAssetImportPlugin({
      authoredSourceOnly,
      handlesInstalledModule,
      packageRoot: input.packageRoot,
    }),
    createAuthoredRelativeExtensionResolverPlugin({
      authoredSourceOnly,
      extensions,
      handlesInstalledModule,
    }),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: input.packageRoot,
      authoredSourceOnly,
      extensions,
      handlesInstalledModule,
    }),
  ];
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
