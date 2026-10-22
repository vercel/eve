import { existsSync } from "node:fs";
import { join } from "node:path";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { authoredModuleConditions } from "#internal/authored-module-conditions.js";
import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

/** Rolldown options shared by every authored module bundle of one package. */
export function createAuthoredModuleBuildOptions(input: {
  readonly packageBoundaryPlugin: Record<string, unknown>;
  readonly packageRoot: string;
  readonly plugins: readonly (object | null)[];
}): Record<string, unknown> {
  return {
    cwd: input.packageRoot,
    platform: "node",
    plugins: [
      ...input.plugins,
      createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
      createAuthoredAssetImportPlugin({ packageRoot: input.packageRoot }),
      createAuthoredPackageTsConfigPathsPlugin({
        appPackageRoot: input.packageRoot,
        extensions: RESOLVE_EXTENSIONS,
      }),
      createNodeEsmCompatBannerPlugin({ includeRequire: true }),
      input.packageBoundaryPlugin,
    ].filter((plugin) => plugin !== null),
    resolve: {
      conditionNames: authoredModuleConditions(),
      extensions: [...RESOLVE_EXTENSIONS],
    },
    tsconfig: resolveAuthoredTsConfigPath(input.packageRoot),
  };
}

/**
 * Source maps for bundles evaluated in this process. Node reads inline maps only
 * when source maps are enabled; otherwise V8 retains the map comment as part of
 * every imported module's source text, often most of its size.
 */
export function evaluatedBundleSourcemap(): "inline" | false {
  return process.sourceMapsEnabled ? "inline" : false;
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
