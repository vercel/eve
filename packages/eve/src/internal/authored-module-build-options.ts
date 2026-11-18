import type { InputOptions, Plugin } from "rolldown";

import { authoredModuleConditions } from "#internal/authored-module-conditions.js";
import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import {
  createAuthoredPlugins,
  resolveAuthoredTsConfigPath,
} from "#internal/bundler/authored-plugins.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

export function createAuthoredModuleBuildOptions(input: {
  readonly packageBoundaryPlugin: Plugin;
  readonly packageRoot: string;
  readonly plugins: readonly (Plugin | null)[];
}): InputOptions {
  return {
    cwd: input.packageRoot,
    platform: "node",
    plugins: [
      ...input.plugins,
      ...createAuthoredPlugins({ packageRoot: input.packageRoot }),
      createNodeEsmCompatBannerPlugin(),
      input.packageBoundaryPlugin,
    ],
    resolve: {
      conditionNames: authoredModuleConditions(),
      extensions: [...RESOLVE_EXTENSIONS],
    },
    tsconfig: resolveAuthoredTsConfigPath(input.packageRoot),
  };
}

export function evaluatedBundleSourcemap(): "inline" | false {
  return process.sourceMapsEnabled ? "inline" : false;
}
