import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
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
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import {
  buildSingleRolldownChunk,
  buildWithNitroRolldown,
} from "#internal/bundler/nitro-rolldown.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import { prepareAuthoredWorkflowDirectives } from "#internal/workflow-bundle/authored-workflow-directives.js";
import { createDynamicCapabilityTransformPlugin } from "#internal/workflow-bundle/dynamic-capability-transform-plugin.js";
import {
  applyWorkflowTransform,
  isAuthoredApplicationModule,
} from "#internal/workflow-bundle/workflow-builders.js";

const AUTHORED_BUNDLED_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH = join(
  "node_modules",
  ".cache",
  "eve",
  "authored-modules",
);
const CHANNEL_MODULE_CACHE_KEY = "__eveChannelModuleCache__";

export interface AuthoredModuleLoadOptions {
  readonly externalDependencies?: readonly string[];
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
 * Bundles one authored entry for immediate dev/eval loading. Package dependencies
 * remain external while relative authored source is inlined.
 */
export async function bundleAuthoredModuleCode(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  return await buildAuthoredModuleBundle(modulePath, options, {
    channelIdentity: true,
    packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot,
    }),
    plugins: [createAuthoredWorkflowDirectivePlugin({ appRoot: packageRoot })],
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
  const code = await buildAuthoredModuleBundle(modulePath, options, {
    // Generation bundles must not reference process state: the channel
    // identity plugin emits reads of a process-global cache keyed by live
    // source paths, which an immutable retained artifact cannot depend on.
    channelIdentity: false,
    packageBoundaryPlugin: createGenerationPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot: resolveAuthoredPackageRoot(modulePath),
    }),
    plugins: [createAuthoredDirectiveGuardPlugin()],
    sourcemap: false,
  });

  return removeRolldownModuleRegionComments(code);
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
    createAuthoredAssetImportPlugin({ packageRoot: input.packageRoot }),
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
 * Bundles every runtime-authored module in one immutable generation graph.
 * Shared dependencies are parsed and emitted once instead of once per authored
 * entry.
 */
/** The module map bundle plus the identity of its Workflow-bearing sources. */
export interface AuthoredModuleMapBundle {
  readonly code: string;
  /**
   * Hash of every application module reachable from one that declares a
   * Workflow directive, or `undefined` when the application declares none.
   * Those sources also feed the workflow driver and the server's step
   * registrations, so a change to any of them must rebuild the host.
   */
  readonly workflowSourceFingerprint: string | undefined;
}

export async function bundleAuthoredModuleMapForGeneration(input: {
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
}): Promise<AuthoredModuleMapBundle> {
  const packageRoot = resolveAuthoredPackageRoot(input.manifest.agentRoot);
  const programmaticLoaderImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/programmatic-source-loader.ts",
  );
  const externalDependencies = normalizeExternalDependencies([
    ...(input.manifest.config.build?.externalDependencies ?? []),
    ...input.manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : (subagent.configResolver.build?.externalDependencies ?? []),
    ),
  ]);
  const moduleMapSource = createCompiledModuleMapSource({
    manifest: input.manifest,
    moduleMapPath: input.moduleMapPath,
    programmaticLoaderImportSpecifier,
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
  const workflowSources = new AuthoredWorkflowSourceRecorder(packageRoot);
  const plugins = [
    createVirtualGenerationModuleMapPlugin({
      id: input.moduleMapPath,
      source: moduleMapSource,
    }),
    createExternalRuntimeImportPlugin(programmaticLoaderImportSpecifier),
    // Workflow bodies are hoisted and stubbed before callbacks are stamped:
    // the stamping transform must see the stub, never the directive.
    createAuthoredWorkflowDirectivePlugin({ appRoot: packageRoot, recorder: workflowSources }),
    createDynamicCapabilityTransformPlugin(),
    workflowSources.graphPlugin(),
    extensionScopePlugin,
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin({ packageRoot }),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: packageRoot,
      extensions: RESOLVE_EXTENSIONS,
    }),
    createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    createGenerationPackageBoundaryPlugin({ externalDependencies, packageRoot }),
  ].filter((plugin) => plugin !== null);

  try {
    const chunk = await buildSingleRolldownChunk("authored module map", {
      cwd: packageRoot,
      input: input.moduleMapPath,
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
    return {
      code: removeRolldownModuleRegionComments(chunk.code),
      workflowSourceFingerprint: workflowSources.fingerprint(),
    };
  } catch (error) {
    throw createAuthoredModuleBundleError(input.moduleMapPath, error);
  }
}

function createExternalRuntimeImportPlugin(importSpecifier: string): Record<string, unknown> {
  const normalizedImportSpecifier = normalizeEsmImportSpecifier(importSpecifier);
  return {
    name: "eve-external-runtime-import",
    resolveId(id: string) {
      return id === normalizedImportSpecifier
        ? { external: true, id: normalizedImportSpecifier }
        : undefined;
    },
  };
}

/**
 * Records, during one module map build, which application modules declare
 * Workflow directives and what every module imports, then fingerprints the
 * sources reachable from the directive-bearing ones. Reusing the build's own
 * resolution keeps the fingerprint exact for aliases and extension probing
 * without a second import resolver.
 */
class AuthoredWorkflowSourceRecorder {
  readonly #appRoot: string;
  readonly #directiveModules = new Set<string>();
  readonly #imports = new Map<string, readonly string[]>();
  readonly #sources = new Map<string, string>();

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  record(id: string, source: string, hasDirectives: boolean): void {
    this.#sources.set(id, source);
    if (hasDirectives) this.#directiveModules.add(id);
  }

  graphPlugin(): Record<string, unknown> {
    const imports = this.#imports;
    return {
      name: "eve-authored-module-graph",
      buildEnd(this: RolldownModuleGraphContext) {
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (info === null) continue;
          imports.set(id, [...info.importedIds, ...info.dynamicallyImportedIds]);
        }
      },
    };
  }

  fingerprint(): string | undefined {
    if (this.#directiveModules.size === 0) return undefined;

    const reachable = new Set<string>();
    const queue = [...this.#directiveModules];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (reachable.has(id) || !this.#sources.has(id)) continue;
      reachable.add(id);
      queue.push(...(this.#imports.get(id) ?? []));
    }

    const hash = createHash("sha256");
    for (const id of [...reachable].sort()) {
      hash
        .update(relative(this.#appRoot, id).split(sep).join("/"))
        .update("\0")
        .update(this.#sources.get(id) ?? "")
        .update("\0");
    }
    return hash.digest("hex");
  }
}

interface RolldownModuleGraphContext {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    readonly dynamicallyImportedIds: readonly string[];
    readonly importedIds: readonly string[];
  } | null;
}

function createVirtualGenerationModuleMapPlugin(input: {
  readonly id: string;
  readonly source: string;
}): Record<string, unknown> {
  return {
    name: "eve-generation-module-map",
    resolveId(id: string) {
      return id === input.id ? id : undefined;
    },
    load(id: string) {
      return id === input.id ? { code: input.source, moduleType: "js" as const } : undefined;
    },
  };
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
    options.extensionScopeNamespace === undefined
      ? null
      : createFixedNamespaceScopePlugin(options.extensionScopeNamespace),
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin({ packageRoot }),
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

      const { hasDirectives } = await prepareAuthoredWorkflowDirectives({ filePath: id, source });
      if (hasDirectives) {
        throw new Error(
          `Module "${id}" uses Workflow directives ("use step" or "use workflow"). ` +
            "Workflow directives are supported in application modules only, not in extensions or instrumentation.",
        );
      }
      return undefined;
    },
  };
}

/**
 * Compiles Workflow directives in application modules for a server-side
 * bundle that does not register steps: `"use step"` functions keep their
 * bodies and gain a `stepId`, and `"use workflow"` functions become
 * references the harness starts as durable runs. Step registration itself
 * happens once, through the workflow step entrypoint the application host
 * bundles from the same sources.
 */
function createAuthoredWorkflowDirectivePlugin(input: {
  readonly appRoot: string;
  readonly recorder?: AuthoredWorkflowSourceRecorder;
}): Record<string, unknown> {
  return {
    name: "eve-authored-workflow-directives",
    async transform(source: string, id: string) {
      if (!AUTHORED_BUNDLED_MODULE_EXTENSION.test(id) || isNodeModulesPath(id)) {
        return undefined;
      }
      if (!isAuthoredApplicationModule(id, input.appRoot)) {
        return undefined;
      }

      const transformed = await applyWorkflowTransform(id, source, "client", id, input.appRoot);
      const { steps, workflows } = transformed.workflowManifest;
      input.recorder?.record(id, source, steps !== undefined || workflows !== undefined);
      return transformed.code === source ? undefined : { code: transformed.code, map: null };
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

  const bundleHash = createHash("sha1")
    .update(modulePath)
    .update("\0")
    .update(externalDependencies.join("\0"))
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

  return `${modulePath}\0${externalDependencies.join("\0")}\0${options.extensionScopeNamespace ?? ""}`;
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
