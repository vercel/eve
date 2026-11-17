import { join, resolve } from "node:path";

import { writeAuthoredModuleCacheFile } from "#internal/authored-module-cache.js";
import {
  createAuthoredModuleBuildOptions,
  evaluatedBundleSourcemap,
} from "#internal/authored-module-build-options.js";
import {
  AUTHORED_BUNDLED_MODULE_EXTENSION,
  AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH,
  createAuthoredWorkflowDirectivePlugin,
} from "#internal/authored-module-loader.js";
import {
  createRuntimeLoaderPackageBoundaryPlugin,
  normalizeExternalDependencies,
  resolveAuthoredPackageRoot,
} from "#internal/authored-package-boundary.js";
import { buildWithRolldown } from "#internal/bundler/rolldown.js";
import { toErrorMessage } from "#shared/errors.js";

export interface AuthoredModuleGraph {
  entryPath(
    modulePath: string,
    externalDependencies: readonly string[],
  ): Promise<string | undefined>;
}

export function createAuthoredModuleGraph(
  modulePaths: readonly string[],
  options: { readonly appRoot?: string } = {},
): AuthoredModuleGraph {
  const entries = [...new Set(modulePaths.map((modulePath) => resolve(modulePath)))].filter(
    (modulePath) => AUTHORED_BUNDLED_MODULE_EXTENSION.test(modulePath),
  );
  const builds = new Map<string, Promise<ReadonlyMap<string, string> | undefined>>();
  return {
    async entryPath(modulePath, externalDependencies) {
      const externals = normalizeExternalDependencies(externalDependencies);
      const key = externals.join("\0");
      let build = builds.get(key);
      if (build === undefined) {
        build = writeAuthoredModuleGraph(entries, externals, options.appRoot).catch(
          (error: unknown) => {
            console.warn(
              `eve: could not bundle ${entries.length} authored modules as one graph, so each module is bundled and evaluated on its own. Build memory then grows with the number of modules. Cause: ${toErrorMessage(error)}`,
            );
            return undefined;
          },
        );
        builds.set(key, build);
      }
      return (await build)?.get(resolve(modulePath));
    },
  };
}

async function writeAuthoredModuleGraph(
  modulePaths: readonly string[],
  externalDependencies: readonly string[],
  appRoot: string | undefined,
): Promise<ReadonlyMap<string, string>> {
  const entryPaths = new Map<string, string>();
  if (modulePaths.length === 0) return entryPaths;
  const packageRoot = resolveAuthoredPackageRoot(modulePaths[0]!);
  const inputs = new Map(
    modulePaths
      .filter((modulePath) => resolveAuthoredPackageRoot(modulePath) === packageRoot)
      .map((modulePath, index) => [`entry-${index}`, modulePath]),
  );
  const sourcemap = evaluatedBundleSourcemap();
  const fileName = sourcemap === false ? "[name]-[hash].mjs" : "[name]-[hash]-mapped.mjs";
  const result = await buildWithRolldown({
    ...createAuthoredModuleBuildOptions({
      packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
        externalDependencies: [...externalDependencies],
        packageRoot,
      }),
      packageRoot,
      plugins: [createAuthoredWorkflowDirectivePlugin({ appRoot: appRoot ?? packageRoot })],
    }),
    input: Object.fromEntries(inputs),
    preserveEntrySignatures: "strict",
    write: false,
    output: {
      chunkFileNames: fileName,
      codeSplitting: true,
      comments: false,
      entryFileNames: fileName,
      format: "esm",
      sourcemap,
      strictExecutionOrder: true,
    },
  });
  const directoryPath = join(packageRoot, AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH);
  for (const item of result.output) {
    if (item.type !== "chunk") continue;
    const filePath = writeAuthoredModuleCacheFile(directoryPath, item.fileName, item.code);
    const modulePath = item.isEntry ? inputs.get(item.name) : undefined;
    if (modulePath !== undefined) entryPaths.set(modulePath, filePath);
  }
  return entryPaths;
}
