import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
import { buildSingleRolldownChunk } from "#internal/bundler/rolldown.js";
import { toErrorMessage } from "#shared/errors.js";

export type AuthoredModuleLoader = () => Promise<unknown>;

export interface AuthoredModuleGraph {
  loader(
    modulePath: string,
    externalDependencies: readonly string[],
  ): Promise<AuthoredModuleLoader | undefined>;
  warnIfBundledPerModule(): void;
}

const GRAPH_ENTRY_ID = "\0eve-authored-module-graph";

export function createAuthoredModuleGraph(
  modulePaths: readonly string[],
  options: { readonly appRoot?: string } = {},
): AuthoredModuleGraph {
  const entries = [...new Set(modulePaths.map((modulePath) => resolve(modulePath)))].filter(
    (modulePath) => AUTHORED_BUNDLED_MODULE_EXTENSION.test(modulePath),
  );
  const builds = new Map<string, Promise<ReadonlyMap<string, AuthoredModuleLoader> | undefined>>();
  const failures = new Map<string, unknown>();
  let reportedFailure = false;
  return {
    async loader(modulePath, externalDependencies) {
      const key = externalDependenciesKey(externalDependencies);
      let build = builds.get(key);
      if (build === undefined) {
        build = writeAuthoredModuleGraph(
          entries,
          normalizeExternalDependencies(externalDependencies),
          options.appRoot,
        ).catch((error: unknown) => {
          failures.set(key, error);
          return undefined;
        });
        builds.set(key, build);
      }
      return (await build)?.get(resolve(modulePath));
    },
    warnIfBundledPerModule() {
      if (reportedFailure || failures.size === 0) return;
      reportedFailure = true;
      const [failure] = failures.values();
      console.warn(
        `eve: could not bundle ${entries.length} authored modules as one graph, so each module was bundled and evaluated on its own. Build memory then grows with the number of modules. Cause: ${toErrorMessage(failure)}`,
      );
    },
  };
}

function externalDependenciesKey(externalDependencies: readonly string[]): string {
  return normalizeExternalDependencies(externalDependencies).join("\0");
}

async function writeAuthoredModuleGraph(
  modulePaths: readonly string[],
  externalDependencies: readonly string[],
  appRoot: string | undefined,
): Promise<ReadonlyMap<string, AuthoredModuleLoader>> {
  const loaders = new Map<string, AuthoredModuleLoader>();
  if (modulePaths.length === 0) return loaders;
  const packageRoot = resolveAuthoredPackageRoot(modulePaths[0]!);
  const entries = modulePaths.filter(
    (modulePath) => resolveAuthoredPackageRoot(modulePath) === packageRoot,
  );
  const graphSource = `export default [${entries
    .map((modulePath) => `() => import(${JSON.stringify(modulePath)})`)
    .join(",")}];`;
  const sourcemap = evaluatedBundleSourcemap();
  const chunk = await buildSingleRolldownChunk("authored module graph", {
    ...createAuthoredModuleBuildOptions({
      packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
        externalDependencies: [...externalDependencies],
        packageRoot,
      }),
      packageRoot,
      plugins: [
        {
          name: "eve-authored-module-graph-entry",
          resolveId: (id: string) => (id === GRAPH_ENTRY_ID ? id : undefined),
          load: (id: string) => (id === GRAPH_ENTRY_ID ? graphSource : undefined),
        },
        createAuthoredWorkflowDirectivePlugin({ appRoot: appRoot ?? packageRoot }),
      ],
    }),
    input: GRAPH_ENTRY_ID,
    output: {
      comments: false,
      entryFileNames: sourcemap === false ? "graph-[hash].mjs" : "graph-[hash]-mapped.mjs",
      format: "esm",
      sourcemap,
      strictExecutionOrder: true,
    },
  });
  const filePath = writeAuthoredModuleCacheFile(
    join(packageRoot, AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH),
    chunk.fileName,
    chunk.code,
  );
  const graph = (await import(pathToFileURL(filePath).href)) as {
    readonly default: readonly AuthoredModuleLoader[];
  };
  entries.forEach((modulePath, index) => loaders.set(modulePath, graph.default[index]!));
  return loaders;
}
