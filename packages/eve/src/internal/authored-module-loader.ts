import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type {
  CompiledExternalDependencyPlan,
  CompiledExternalDependencyPlanSession,
} from "#compiler/external-dependency-plan.js";
import { createCompiledExternalDependencyPlanIdentity } from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { createCompiledModuleMapIntegrityPlugin } from "#compiler/module-map-integrity-plugin.js";
import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { assertNoWorkflowDirectivePrologue } from "#internal/authored-directive-prologue.js";
import { createAuthoredModuleBundleError } from "#internal/authored-module-bundle.js";
import { createAuthoredModuleEvaluationError } from "#internal/authored-module-evaluation-error.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";
import {
  createExtensionScopePlugin,
  createFixedNamespaceScopePlugin,
} from "#internal/bundler/extension-scope-plugin.js";
import {
  CACHED_CHANNEL_PREFIX,
  RESOLVE_EXTENSIONS,
  createDistributionPackageBoundaryPlugin,
  createGenerationPackageBoundaryPlugin,
  createRuntimeLoaderPackageBoundaryPlugin,
  isNodeModulesPath,
  normalizeExternalDependencies,
  type GenerationExternalDependencyMode,
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import { materializeCompiledExternalDependencyPlan } from "#internal/materialize-external-dependencies.js";
import {
  buildSingleRolldownChunk,
  buildWithNitroRolldown,
} from "#internal/bundler/nitro-rolldown.js";
import {
  createOptionalSandboxEngineDependencyPlugin,
  OPTIONAL_SANDBOX_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/bundler/optional-sandbox-engine-dependency-plugin.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import { createDynamicCapabilityTransformPlugin } from "#internal/workflow-bundle/dynamic-capability-transform-plugin.js";
import {
  resolvePackageCompiledFilePath,
  resolvePackageRoot,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { createFrameworkSourceRevisionPlugin } from "#framework-sources/revision-plugin.js";
import { readCompiledFrameworkSourceRevision } from "#framework-sources/revision.js";
import { verifyCompiledExternalDependencyPlanFiles } from "#compiler/external-dependency-plan.js";
import {
  createGenerationModuleMapBundleEntry,
  type GenerationModuleMapDescriptorProjection,
} from "#internal/generation-module-map-projection.js";

const AUTHORED_BUNDLED_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH = join(
  "node_modules",
  ".cache",
  "eve",
  "authored-modules",
);
const CHANNEL_MODULE_CACHE_KEY = "__eveChannelModuleCache__";

export interface AuthoredModuleLoadOptions {
  readonly captureExternalDependencyWitnesses?: boolean;
  readonly externalDependencies?: readonly string[];
  readonly externalDependencyPlan?: CompiledExternalDependencyPlan;
  readonly externalDependencyPlanSession?: CompiledExternalDependencyPlanSession;
  /**
   * When set, the module being loaded is extension-owned: its
   * `defineState`/`defineExtension` calls (and those of its same-package
   * dependencies bundled with it) are scoped to this namespace at bundle time.
   */
  readonly extensionScopeNamespace?: string;
}

function getChannelModuleCache(): Map<string, unknown> | undefined {
  return (globalThis as Record<string, unknown>)[CHANNEL_MODULE_CACHE_KEY] as
    | Map<string, unknown>
    | undefined;
}

/**
 * In-flight load deduplication map keyed by the absolute module path.
 *
 * The compiler walks every authored slot concurrently
 * (`compileChannelDefinition` and `buildChannelRouteIdentityMap` both
 * load the same channel module via `Promise.all`), so the same module
 * path is frequently loaded twice in parallel. Without dedup, both
 * callers race the bundler write/import pipeline against the
 * same `node_modules/.cache/.../<hash>.mjs` file: one call's
 * `writeFile` can truncate the bundle while another's `import()` is
 * still resolving it, surfacing as intermittent
 * "Expected … to match the public eve shape" failures during
 * compilation.
 *
 * The map only holds in-flight promises; once a load settles the entry
 * is cleared so subsequent compiles (e.g. a dev-server reload after
 * the author edits a file) re-run the bundle pipeline against the
 * fresh source. Node's ESM cache then dedupes by content-hashed URL for
 * unchanged files. The companion "skip write when the cache file already
 * exists" check inside {@link loadBundledAuthoredModule} eliminates the
 * write/read race even when two non-concurrent compile passes overlap on
 * the same hashed bundle path.
 */
const inFlightModuleLoads = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Loads one authored module namespace from disk during compile-time
 * discovery. Concurrent loads of the same `modulePath` share a single
 * Promise so the underlying bundle/import pipeline runs once.
 */
export function loadAuthoredModuleNamespace(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<Record<string, unknown>> {
  const cacheKey = resolve(modulePath);
  const inFlightKey = createInFlightModuleLoadKey(cacheKey, options);
  const inFlight = inFlightModuleLoads.get(inFlightKey);

  if (inFlight !== undefined) {
    return inFlight;
  }

  const loadPromise = (async () => {
    try {
      return await doLoadAuthoredModuleNamespace(modulePath, options);
    } finally {
      inFlightModuleLoads.delete(inFlightKey);
    }
  })();
  inFlightModuleLoads.set(inFlightKey, loadPromise);
  return loadPromise;
}

async function doLoadAuthoredModuleNamespace(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<Record<string, unknown>> {
  const loadedModule = AUTHORED_BUNDLED_MODULE_EXTENSION.test(modulePath)
    ? await loadBundledAuthoredModule(modulePath, options)
    : await import(createFileImportSpecifier(modulePath));

  return expectObjectRecord(
    loadedModule,
    `Expected "${modulePath}" to export a module namespace object.`,
  );
}

function createFileImportSpecifier(modulePath: string): string {
  const normalizedPath = modulePath.replaceAll("\\", "/");

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `file:///${encodeURI(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeURI(normalizedPath)}`;
  }

  return normalizedPath;
}

/**
 * Bundles one authored entry for immediate compile-time loading. Installed
 * package imports execute from content-addressed captures so a subsequent
 * compile cannot reuse an earlier package revision from Node's module cache.
 */
export async function bundleAuthoredModuleCode(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  const externalDependencyPlanSession = options.externalDependencyPlanSession;
  const externalDependencyPlan = await resolveAuthoredExternalDependencyPlan(packageRoot, options);
  const materialized = await materializeCompiledExternalDependencyPlan({
    destinationRoot: join(
      packageRoot,
      "node_modules",
      ".cache",
      "eve",
      "authored-external-dependencies",
    ),
    plan: externalDependencyPlan,
  });
  return await buildAuthoredModuleBundle(modulePath, options, {
    channelIdentity: true,
    packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
      captureExternalDependencyPlan:
        externalDependencyPlanSession === undefined
          ? undefined
          : async (capture) =>
              await externalDependencyPlanSession.captureResolvedPackage({
                ...capture,
                ...(options.captureExternalDependencyWitnesses === true
                  ? { witnessSourceRoot: packageRoot }
                  : {}),
              }),
      externalDependencyPlan: materialized.plan,
      packageRoot,
    }),
    plugins: [],
    sourcemap: "inline",
  });
}

/**
 * Bundles one authored entry for an immutable development generation. Ordinary
 * package dependencies are inlined so the emitted code stays executable after
 * the original workspace changes; framework runtime imports and explicitly
 * configured external dependencies keep their normal runtime resolution.
 */
export async function bundleAuthoredModuleForGeneration(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const externalDependencyPlan = await resolveAuthoredExternalDependencyPlan(
    resolveAuthoredPackageRoot(modulePath),
    options,
  );
  const code = await buildAuthoredModuleBundle(modulePath, options, {
    // Generation bundles must not reference process state: the channel
    // identity plugin emits reads of a process-global cache keyed by live
    // source paths, which an immutable retained artifact cannot depend on.
    channelIdentity: false,
    packageBoundaryPlugin: createGenerationPackageBoundaryPlugin({
      externalDependencyMode: "preserve-specifier",
      externalDependencyPlan,
    }),
    plugins: [createAuthoredDirectiveGuardPlugin()],
    sourcemap: false,
  });

  return removeRolldownModuleRegionComments(code);
}

async function resolveAuthoredExternalDependencyPlan(
  packageRoot: string,
  options: AuthoredModuleLoadOptions,
): Promise<CompiledExternalDependencyPlan> {
  const dependencyIds = externalDependencyPlanPackageNames(
    normalizeExternalDependencies(options.externalDependencies),
  );
  if (options.externalDependencyPlan !== undefined) {
    const entries = dependencyIds.map((dependencyId) => {
      const entry = options.externalDependencyPlan!.entries.find(
        (candidate) => candidate.id === dependencyId,
      );
      if (entry === undefined) {
        throw new Error(
          `Cannot load authored package "${packageRoot}" without external dependency plan entry "${dependencyId}".`,
        );
      }
      return entry;
    });
    return { entries };
  }
  if (dependencyIds.length === 0) return { entries: [] };
  throw new Error(
    `Cannot load authored package "${packageRoot}" with configured external dependencies before the compiler selects their plan.`,
  );
}

/** One path-preserving entry in an extension distribution graph. */
export interface ExtensionDistributionGraphEntry {
  /** Output path relative to `dist/`, without the `.mjs` extension. */
  readonly name: string;
  /** Absolute authored module path. */
  readonly path: string;
}

/**
 * Transforms an extension's authored modules as one code-split graph while
 * preserving an entry for every agent-shaped source module. Package imports
 * remain external for the consuming app and source maps are omitted.
 */
export async function bundleExtensionDistributionGraph(input: {
  readonly entries: readonly ExtensionDistributionGraphEntry[];
  readonly packageRoot: string;
  readonly runtimeDependencies: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const plugins = [
    createAuthoredDirectiveGuardPlugin(),
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin(),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: input.packageRoot,
      extensions: RESOLVE_EXTENSIONS,
    }),
    createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    createDistributionPackageBoundaryPlugin({
      packageRoot: input.packageRoot,
      runtimeDependencies: input.runtimeDependencies,
    }),
  ];

  try {
    const result = await buildWithNitroRolldown({
      cwd: input.packageRoot,
      input: Object.fromEntries(input.entries.map((entry) => [entry.name, entry.path])),
      platform: "node",
      plugins,
      resolve: {
        extensions: [...RESOLVE_EXTENSIONS],
      },
      tsconfig: resolveAuthoredTsConfigPath(input.packageRoot),
      write: false,
      output: {
        chunkFileNames: "_chunks/[name]-[hash].mjs",
        codeSplitting: true,
        comments: false,
        entryFileNames: "[name].mjs",
        format: "esm",
        sourcemap: false,
      },
    });

    const files = new Map<string, string>();
    for (const item of result.output) {
      if (item.type === "chunk") {
        files.set(item.fileName, removeRolldownModuleRegionComments(item.code));
      }
    }
    return files;
  } catch (error) {
    throw createAuthoredModuleBundleError(input.packageRoot, error);
  }
}

/**
 * Bundles the exact compiled module-map descriptor and every runtime-authored
 * module it selects into one immutable generation graph. Shared dependencies
 * are parsed and emitted once instead of once per authored entry.
 */
export async function bundleAuthoredModuleMapForGeneration(input: {
  readonly descriptorProjection?: GenerationModuleMapDescriptorProjection;
  readonly expectedIdentity: string;
  readonly externalDependencyMode: GenerationExternalDependencyMode;
  readonly externalDependencyPlan: CompiledExternalDependencyPlan;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
}): Promise<string> {
  const packageRoot = resolveAuthoredPackageRoot(input.manifest.agentRoot);
  const bundleEntry = createGenerationModuleMapBundleEntry({
    moduleMapPath: input.moduleMapPath,
    moduleMapSource: input.moduleMapSource,
    projection: input.descriptorProjection,
    sourceManifest: input.manifest,
  });
  const extensionScopePlugin = createExtensionScopePlugin(
    [input.manifest, ...input.manifest.subagents.map((subagent) => subagent.agent)].flatMap(
      (node) =>
        node.extensionMounts.map((mount) => ({
          packageNamespace: mount.packageNamespace,
          sourceRoot: mount.sourceRoot,
        })),
    ),
  );
  const plugins = [
    bundleEntry.plugin,
    createCompiledModuleMapIntegrityPlugin({
      expectedIdentity: input.expectedIdentity,
      manifest: input.manifest,
    }),
    {
      name: "eve-compiled-external-dependency-integrity",
      async buildStart() {
        await verifyCompiledExternalDependencyPlanFiles(input.externalDependencyPlan);
      },
      async buildEnd() {
        await verifyCompiledExternalDependencyPlanFiles(input.externalDependencyPlan);
      },
    },
    createFrameworkSourceRevisionPlugin({
      expectedRevision: readCompiledFrameworkSourceRevision(input.manifest),
    }),
    createEvePackageImportResolverPlugin(),
    createDynamicCapabilityTransformPlugin(),
    createAuthoredDirectiveGuardPlugin(),
    extensionScopePlugin,
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin(),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: packageRoot,
      extensions: RESOLVE_EXTENSIONS,
    }),
    createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    createOptionalSandboxEngineDependencyPlugin(
      Object.values(OPTIONAL_SANDBOX_ENGINE_PACKAGES_BY_BACKEND_NAME),
    ),
    createGenerationPackageBoundaryPlugin({
      externalDependencyMode: input.externalDependencyMode,
      externalDependencyPlan: input.externalDependencyPlan,
    }),
  ].filter((plugin) => plugin !== null);

  try {
    const chunk = await buildSingleRolldownChunk("authored module map", {
      cwd: packageRoot,
      input: bundleEntry.inputPath,
      platform: "node",
      plugins,
      resolve: {
        conditionNames: ["eve-source"],
        extensions: [...RESOLVE_EXTENSIONS],
      },
      tsconfig: resolveAuthoredTsConfigPath(packageRoot),
      output: {
        comments: false,
        format: "esm",
        sourcemap: false,
      },
    });
    return removeRolldownModuleRegionComments(chunk.code);
  } catch (error) {
    throw createAuthoredModuleBundleError(input.moduleMapPath, error);
  }
}

/**
 * Resolves eve's private package imports to the files present in the executing
 * installation. Generation bundling opts into the `eve-source` condition for
 * linked workspace packages, but published eve packages intentionally omit
 * `src/`; resolving these edges explicitly keeps package-owned programmatic
 * sources bundleable in both layouts.
 */
function createEvePackageImportResolverPlugin(): Record<string, unknown> {
  const packageRoot = realpathSync.native(resolvePackageRoot());

  return {
    name: "eve-package-imports",
    resolveId(source: string, importer: string | undefined) {
      if (importer === undefined || !source.startsWith("#")) return undefined;

      const importerPath = resolve(importer);
      if (!isPathInsideOrEqual(realpathExistingAncestor(importerPath), packageRoot)) {
        return undefined;
      }

      if (source.startsWith("#compiled/")) {
        return {
          id: resolvePackageCompiledFilePath(`src/compiled/${source.slice("#compiled/".length)}`),
        };
      }

      const match = source.match(/^#(.+)\.js$/);
      if (match === null) return undefined;

      return {
        id: resolvePackageSourceFilePath(`src/${match[1]}.ts`),
      };
    },
  };
}

function realpathExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return path;
    candidate = parent;
  }
  return realpathSync.native(candidate);
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function buildAuthoredModuleBundle(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
  configuration: {
    readonly channelIdentity: boolean;
    readonly packageBoundaryPlugin: Record<string, unknown>;
    readonly plugins: readonly Record<string, unknown>[];
    readonly sourcemap: false | "inline";
  },
): Promise<string> {
  const channelCache = configuration.channelIdentity ? getChannelModuleCache() : undefined;
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  const tsconfigPath = resolveAuthoredTsConfigPath(packageRoot);
  const channelIdentityPlugin =
    channelCache && channelCache.size > 0
      ? {
          name: "eve-channel-identity",
          async resolveId(
            this: RolldownResolveContext,
            source: string,
            importer: string | undefined,
            options: { kind: string },
          ) {
            if (!/channels[/\\]/.test(source) || options.kind !== "import-statement") {
              return undefined;
            }

            const resolved = await this.resolve(source, importer, {
              kind: options.kind,
              skipSelf: true,
            });

            if (resolved === null || typeof resolved.id !== "string") {
              return undefined;
            }

            const resolvedPath = resolve(resolved.id);

            if (!channelCache.has(resolvedPath)) {
              return undefined;
            }

            return { id: `${CACHED_CHANNEL_PREFIX}${resolvedPath}` };
          },
          load(id: string) {
            if (!id.startsWith(CACHED_CHANNEL_PREFIX)) {
              return undefined;
            }

            const cachedPath = id.slice(CACHED_CHANNEL_PREFIX.length);
            return {
              code: [
                `const cache = globalThis["${CHANNEL_MODULE_CACHE_KEY}"];`,
                `export default cache.get(${JSON.stringify(cachedPath)});`,
              ].join("\n"),
              moduleType: "js" as const,
            };
          },
        }
      : null;
  const plugins = [
    channelIdentityPlugin,
    ...configuration.plugins,
    createFrameworkSourceRevisionPlugin(),
    options.extensionScopeNamespace === undefined
      ? null
      : createFixedNamespaceScopePlugin(options.extensionScopeNamespace),
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin(),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: packageRoot,
      extensions: RESOLVE_EXTENSIONS,
    }),
    createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    configuration.packageBoundaryPlugin,
  ].filter((plugin) => plugin !== null);

  try {
    const chunk = await buildSingleRolldownChunk(`authored module for "${modulePath}"`, {
      cwd: packageRoot,
      input: modulePath,
      platform: "node",
      plugins,
      resolve: {
        conditionNames: ["eve-source"],
        extensions: [...RESOLVE_EXTENSIONS],
      },
      tsconfig: tsconfigPath,
      output: {
        comments: false,
        format: "esm",
        sourcemap: configuration.sourcemap,
      },
    });
    return chunk.code;
  } catch (error) {
    throw createAuthoredModuleBundleError(modulePath, error);
  }
}

function createAuthoredDirectiveGuardPlugin(): Record<string, unknown> {
  return {
    name: "eve-authored-directive-guard",
    async transform(source: string, id: string) {
      if (!AUTHORED_BUNDLED_MODULE_EXTENSION.test(id) || isNodeModulesPath(id)) {
        return undefined;
      }

      await assertNoWorkflowDirectivePrologue({ filePath: id, source });
      return undefined;
    },
  };
}

function removeRolldownModuleRegionComments(code: string): string {
  return code
    .split("\n")
    .filter((line) => !line.startsWith("//#region ") && line !== "//#endregion")
    .join("\n");
}

async function loadBundledAuthoredModule(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<unknown> {
  const code = await bundleAuthoredModuleCode(modulePath, options);
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);
  const externalDependencyPlanIdentity =
    options.externalDependencyPlan === undefined
      ? ""
      : createCompiledExternalDependencyPlanIdentity(options.externalDependencyPlan);
  const externalDependencySessionIdentity = options.externalDependencyPlanSession?.cacheKey ?? "";

  const bundleHash = createHash("sha1")
    .update(modulePath)
    .update("\0")
    .update(externalDependencies.join("\0"))
    .update("\0")
    .update(externalDependencyPlanIdentity)
    .update("\0")
    .update(externalDependencySessionIdentity)
    .update("\0")
    .update(options.captureExternalDependencyWitnesses === true ? "witness" : "ordinary")
    .update("\0")
    .update(options.extensionScopeNamespace ?? "")
    .update("\0")
    .update(code)
    .digest("hex");
  const bundleDirectoryPath = join(
    resolveAuthoredPackageRoot(modulePath),
    AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH,
  );
  const bundlePath = join(bundleDirectoryPath, `${bundleHash}.mjs`);

  if (!existsSync(bundlePath)) {
    mkdirSync(bundleDirectoryPath, { recursive: true });
    writeFileSync(bundlePath, code);
  }

  try {
    return await import(`${createFileImportSpecifier(bundlePath)}?v=${bundleHash}`);
  } catch (error) {
    throw createAuthoredModuleEvaluationError(modulePath, error);
  }
}

function createInFlightModuleLoadKey(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): string {
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);
  const externalDependencyPlanIdentity =
    options.externalDependencyPlan === undefined
      ? ""
      : createCompiledExternalDependencyPlanIdentity(options.externalDependencyPlan);
  const externalDependencySessionIdentity = options.externalDependencyPlanSession?.cacheKey ?? "";

  return `${modulePath}\0${externalDependencies.join("\0")}\0${externalDependencyPlanIdentity}\0${externalDependencySessionIdentity}\0${options.captureExternalDependencyWitnesses === true ? "witness" : "ordinary"}\0${options.extensionScopeNamespace ?? ""}`;
}

function resolveAuthoredTsConfigPath(packageRoot: string): string | false {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(packageRoot, fileName);
    if (existsSync(path)) {
      return path;
    }
  }

  return false;
}

function resolveAuthoredPackageRoot(modulePath: string): string {
  let currentDirectory = dirname(modulePath);

  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return realpathSync(currentDirectory);
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(`Failed to resolve the authored package root for "${modulePath}".`);
    }

    currentDirectory = parentDirectory;
  }
}
