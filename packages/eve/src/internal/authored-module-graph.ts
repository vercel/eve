import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createAuthoredModuleBuildOptions } from "#internal/authored-module-build-options.js";
import {
  AUTHORED_BUNDLED_MODULE_EXTENSION,
  AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH,
  createAuthoredWorkflowDirectivePlugin,
  resolveAuthoredPackageRoot,
} from "#internal/authored-module-loader.js";
import {
  createRuntimeLoaderPackageBoundaryPlugin,
  normalizeExternalDependencies,
} from "#internal/authored-package-boundary.js";
import { buildWithNitroRolldown } from "#internal/bundler/nitro-rolldown.js";

/**
 * Bundles a compile's application modules as one code-split graph per set of
 * external dependencies, so a module they share is evaluated once, as in the
 * runtime module map. A module bundled on its own evaluates a private copy of
 * everything it imports.
 */
export interface AuthoredModuleGraph {
  /** Returns the graph entry file for `modulePath`, or `undefined` to bundle it alone. */
  entryPath(
    modulePath: string,
    externalDependencies: readonly string[],
  ): Promise<string | undefined>;
}

export function createAuthoredModuleGraph(modulePaths: readonly string[]): AuthoredModuleGraph {
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
        // Modules fall back to their own bundle, which reports any bundling error.
        build = writeAuthoredModuleGraph(entries, externals).catch(() => undefined);
        builds.set(key, build);
      }
      return (await build)?.get(resolve(modulePath));
    },
  };
}

async function writeAuthoredModuleGraph(
  modulePaths: readonly string[],
  externalDependencies: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const entryPaths = new Map<string, string>();
  if (modulePaths.length === 0) return entryPaths;
  const packageRoot = resolveAuthoredPackageRoot(modulePaths[0]!);
  const inputs = new Map(
    modulePaths
      .filter((modulePath) => resolveAuthoredPackageRoot(modulePath) === packageRoot)
      .map((modulePath, index) => [`entry-${index}`, modulePath]),
  );
  const result = await buildWithNitroRolldown({
    ...createAuthoredModuleBuildOptions({
      packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
        externalDependencies: [...externalDependencies],
        packageRoot,
      }),
      packageRoot,
      plugins: [createAuthoredWorkflowDirectivePlugin({ appRoot: packageRoot })],
    }),
    input: Object.fromEntries(inputs),
    // Each entry chunk must expose exactly its module's exports.
    preserveEntrySignatures: "strict",
    write: false,
    output: {
      chunkFileNames: "[name]-[hash].mjs",
      codeSplitting: true,
      comments: false,
      entryFileNames: "[name]-[hash].mjs",
      format: "esm",
      sourcemap: "inline",
    },
  });
  const directoryPath = join(packageRoot, AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH);
  mkdirSync(directoryPath, { recursive: true });
  for (const item of result.output) {
    if (item.type !== "chunk") continue;
    // File names carry a content hash, so an existing file already has this content.
    const filePath = join(directoryPath, item.fileName);
    if (!existsSync(filePath)) writeFileSync(filePath, item.code);
    const modulePath = item.isEntry ? inputs.get(item.name) : undefined;
    if (modulePath !== undefined) entryPaths.set(modulePath, filePath);
  }
  return entryPaths;
}
