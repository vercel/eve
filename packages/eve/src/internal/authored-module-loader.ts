import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

import type { Plugin } from "rolldown";

import { extensionOverridePaths } from "#compiler/extension-mount-bindings.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import {
  createAuthoredModuleBuildOptions,
  evaluatedBundleSourcemap,
} from "#internal/authored-module-build-options.js";
import { writeAuthoredModuleCacheFile } from "#internal/authored-module-cache.js";
import type { AuthoredModuleGraph } from "#internal/authored-module-graph.js";
import {
  createExtensionMountPlugin,
  EXTENSION_CHUNK_DIRECTORY,
} from "#internal/bundler/extension-mount-plugin.js";
import { createAuthoredModuleBundleError } from "#internal/authored-module-bundle.js";
import { createAuthoredModuleEvaluationError } from "#internal/authored-module-evaluation-error.js";
import {
  createAuthoredPlugins,
  resolveAuthoredTsConfigPath,
} from "#internal/bundler/authored-plugins.js";
import {
  createExtensionScopePlugin,
  createFixedMountScopePlugin,
} from "#internal/bundler/extension-scope-plugin.js";
import {
  RESOLVE_EXTENSIONS,
  createDistributionPackageBoundaryPlugin,
  createGenerationPackageBoundaryPlugin,
  type GenerationHostBundle,
  createRuntimeLoaderPackageBoundaryPlugin,
  isNodeModulesPath,
  normalizeExternalDependencies,
  resolveAuthoredPackageRoot,
} from "#internal/authored-package-boundary.js";
import { expectObjectRecord, interopAuthoredModuleNamespace } from "#internal/authored-module.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { buildSingleRolldownChunk, buildWithRolldown } from "#internal/bundler/rolldown.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import { prepareAuthoredWorkflowDirectives } from "#internal/workflow-bundle/authored-workflow-directives.js";
import {
  applyWorkflowTransform,
  isAuthoredApplicationModule,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";

export const AUTHORED_BUNDLED_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
export const AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH = join(
  "node_modules",
  ".cache",
  "eve",
  "authored-modules",
);

export interface ExtensionMountEntry {
  readonly mountSourcePath: string;
  readonly packageName: string;
  readonly sourceRoot: string;
  readonly specifier: string;
}

export interface AuthoredModuleLoadOptions {
  readonly appRoot?: string;
  readonly externalDependencies?: readonly string[];
  readonly extension?: {
    readonly mountId: string;
    readonly entry?: ExtensionMountEntry;
    readonly ancestors?: readonly (ExtensionMountEntry & { readonly mountId: string })[];
    readonly evaluationId?: string;
  };
  readonly graph?: AuthoredModuleGraph;
}

const inFlightModuleLoads = new Map<string, Promise<Record<string, unknown>>>();

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
    interopAuthoredModuleNamespace(loadedModule),
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

export async function bundleAuthoredModuleCode(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  const mount = options.extension?.entry;
  const mountId = options.extension?.mountId;
  const mountChain =
    mount === undefined
      ? []
      : [...(options.extension?.ancestors ?? []), { ...mount, mountId: mountId! }];
  return await buildAuthoredModuleBundle(modulePath, options, {
    packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot,
      extensionSpecifiers: new Set(mountChain.map((entry) => entry.specifier)),
    }),
    plugins: [
      ...(mount === undefined
        ? []
        : [
            {
              name: "eve-compile-mount-entry",
              resolveId(id: string) {
                return id === "\0eve-compile-mount-entry" ? id : undefined;
              },
              load(id: string) {
                if (id !== "\0eve-compile-mount-entry") return undefined;
                const mountImports = mountChain.map(
                  (entry) =>
                    `import ${JSON.stringify(`${entry.mountSourcePath}?eve-mount=${encodeURIComponent(entry.mountId)}`)};`,
                );
                const contribution = `${modulePath}?eve-mount=${encodeURIComponent(mountId!)}`;
                return `${mountImports.join(" ")} export * from ${JSON.stringify(contribution)}; import entry from ${JSON.stringify(contribution)}; export default entry;`;
              },
            },
          ]),
      createAuthoredWorkflowDirectivePlugin({ appRoot: options.appRoot ?? packageRoot }),
      ...(mount === undefined ? [] : [createExtensionMountPlugin(mountChain)!]),
    ],
    sourcemap: evaluatedBundleSourcemap(),
  });
}

export async function bundleAuthoredModuleForGeneration(
  modulePath: string,
  options: AuthoredModuleLoadOptions & { readonly hostBundle?: GenerationHostBundle } = {},
): Promise<string> {
  return await buildAuthoredModuleBundle(modulePath, options, {
    packageBoundaryPlugin: createGenerationPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot: resolveAuthoredPackageRoot(modulePath),
      hostBundle: options.hostBundle,
    }),
    plugins: [createAuthoredDirectiveGuardPlugin()],
    sourcemap: false,
  });
}

export interface ExtensionDistributionGraphEntry {
  readonly name: string;
  readonly path: string;
}

export async function bundleExtensionDistributionGraph(input: {
  readonly entries: readonly ExtensionDistributionGraphEntry[];
  readonly packageRoot: string;
  readonly runtimeDependencies: readonly string[];
}): Promise<{
  readonly files: ReadonlyMap<string, string>;
  readonly imports: readonly string[];
}> {
  const plugins = [
    createAuthoredDirectiveGuardPlugin(),
    ...createAuthoredPlugins({ packageRoot: input.packageRoot }),
    createNodeEsmCompatBannerPlugin(),
    createDistributionPackageBoundaryPlugin({
      packageRoot: input.packageRoot,
      runtimeDependencies: input.runtimeDependencies,
    }),
  ];

  try {
    const result = await buildWithRolldown({
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
        chunkFileNames: `${EXTENSION_CHUNK_DIRECTORY}/[name]-[hash].mjs`,
        codeSplitting: true,
        comments: false,
        entryFileNames: "[name].mjs",
        format: "esm",
        sourcemap: false,
      },
    });

    const files = new Map<string, string>();
    const imports = new Set<string>();
    for (const item of result.output) {
      if (item.type === "chunk") {
        files.set(item.fileName, item.code);
        for (const specifier of [...item.imports, ...item.dynamicImports]) imports.add(specifier);
      }
    }
    return { files, imports: [...imports] };
  } catch (error) {
    throw createAuthoredModuleBundleError(input.packageRoot, error);
  }
}

export interface AuthoredModuleMapBundle {
  readonly authoredWorkflowModules: AuthoredWorkflowModules;
  readonly code: string;
  readonly sourceModules: readonly string[];
  readonly workflowSourceFingerprint: string | undefined;
}

export async function bundleAuthoredModuleMapForGeneration(input: {
  readonly appRoot: string;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
  readonly resolveExternalPaths?: boolean;
  readonly hostBundle?: GenerationHostBundle;
}): Promise<AuthoredModuleMapBundle> {
  const packageRoot = resolveAuthoredPackageRoot(input.manifest.agentRoot);
  const programmaticLoaderImportSpecifier = resolvePackageSourceFilePath(
    usesDevelopmentExtensionModules(input.manifest)
      ? "src/internal/development-programmatic-source-loader.ts"
      : "src/internal/programmatic-source-loader.ts",
  );
  const externalDependencies = normalizeExternalDependencies([
    ...(input.manifest.config.build?.externalDependencies ?? []),
    ...input.manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : [],
    ),
  ]);
  const moduleMapSource = createCompiledModuleMapSource({
    manifest: input.manifest,
    moduleMapPath: input.moduleMapPath,
    programmaticLoaderImportSpecifier,
  });
  const extensionMounts = [
    input.manifest,
    ...input.manifest.subagents.map((subagent) => subagent.agent),
  ].flatMap((node) => node.extensionMounts);
  const extensionScopePlugin = createExtensionScopePlugin(
    [input.manifest, ...input.manifest.subagents.map((subagent) => subagent.agent)].flatMap(
      (node) =>
        node.extensionMounts.map((mount) => ({
          mountId: mount.mountId,
          sourceRoot: mount.sourceRoot,
        })),
    ),
  );
  const workflowSources = new AuthoredWorkflowSourceRecorder(input.appRoot);

  try {
    const chunk = await buildSingleRolldownChunk("authored module map", {
      ...createAuthoredModuleBuildOptions({
        packageBoundaryPlugin: createGenerationPackageBoundaryPlugin({
          externalDependencies,
          packageRoot,
          extensionSpecifiers: new Set(extensionMounts.map((mount) => mount.specifier)),
          resolveExternalPaths: input.resolveExternalPaths,
          hostBundle: input.hostBundle,
        }),
        packageRoot,
        plugins: [
          createVirtualGenerationModuleMapPlugin({
            id: input.moduleMapPath,
            source: moduleMapSource,
          }),
          createExternalRuntimeImportPlugin(programmaticLoaderImportSpecifier),
          createAuthoredWorkflowDirectivePlugin({
            appRoot: input.appRoot,
            recorder: workflowSources,
          }),
          workflowSources.graphPlugin(),
          createExtensionMountPlugin(extensionMounts, extensionOverridePaths(input.manifest)),
          extensionScopePlugin,
        ],
      }),
      input: input.moduleMapPath,
      output: {
        comments: false,
        format: "esm",
        sourcemap: false,
      },
    });
    return {
      authoredWorkflowModules: workflowSources.modules(),
      code: chunk.code,
      sourceModules: workflowSources.sourceModules().filter((id) => id !== input.moduleMapPath),
      workflowSourceFingerprint: workflowSources.fingerprint(),
    };
  } catch (error) {
    throw createAuthoredModuleBundleError(input.moduleMapPath, error);
  }
}

function usesDevelopmentExtensionModules(manifest: CompiledAgentManifest): boolean {
  return [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].some((node) =>
    Object.values(node.bindings).some(
      (binding) =>
        binding.backing.kind === "programmatic" &&
        binding.backing.registryId.startsWith("eve:development-extension:"),
    ),
  );
}

function createExternalRuntimeImportPlugin(importSpecifier: string): Plugin {
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

class AuthoredWorkflowSourceRecorder {
  readonly #appRoot: string;
  readonly #directiveModules = new Set<string>();
  readonly #imports = new Map<string, readonly string[]>();
  readonly #sources = new Map<string, string>();
  readonly #workflowModules = new Set<string>();

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  record(id: string, source: string, manifest: WorkflowManifest): void {
    this.#sources.set(id, source);
    if (manifest.steps !== undefined || manifest.workflows !== undefined) {
      this.#directiveModules.add(id);
    }
    if (Object.values(manifest.workflows ?? {})[0] !== undefined) this.#workflowModules.add(id);
  }

  sourceModules(): readonly string[] {
    return [...this.#sources.keys()].sort();
  }

  graphPlugin(): Plugin {
    const imports = this.#imports;
    return {
      name: "eve-authored-module-graph",
      buildEnd() {
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (info === null) continue;
          imports.set(id, [...info.importedIds, ...info.dynamicallyImportedIds]);
        }
      },
    };
  }

  modules(): AuthoredWorkflowModules {
    return {
      directiveModules: [...this.#directiveModules].sort(),
      workflowModules: [...this.#workflowModules].sort(),
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

function createVirtualGenerationModuleMapPlugin(input: {
  readonly id: string;
  readonly source: string;
}): Plugin {
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
    readonly packageBoundaryPlugin: Plugin;
    readonly plugins: readonly Plugin[];
    readonly sourcemap: false | "inline";
  },
): Promise<string> {
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  try {
    const chunk = await buildSingleRolldownChunk(`authored module for "${modulePath}"`, {
      ...createAuthoredModuleBuildOptions({
        packageBoundaryPlugin: configuration.packageBoundaryPlugin,
        packageRoot,
        plugins: [
          ...configuration.plugins,
          options.extension === undefined
            ? null
            : createFixedMountScopePlugin(options.extension.mountId),
        ],
      }),
      input: options.extension?.entry === undefined ? modulePath : "\0eve-compile-mount-entry",
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

function createAuthoredDirectiveGuardPlugin(): Plugin {
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

export function createAuthoredWorkflowDirectivePlugin(input: {
  readonly appRoot: string;
  readonly recorder?: AuthoredWorkflowSourceRecorder;
}): Plugin {
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
      input.recorder?.record(id, source, transformed.workflowManifest);
      return transformed.code === source ? undefined : { code: transformed.code, map: null };
    },
  };
}

async function loadBundledAuthoredModule(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<unknown> {
  const graphEntryPath =
    options.extension === undefined
      ? await options.graph?.entryPath(modulePath, options.externalDependencies ?? [])
      : undefined;
  const specifier =
    graphEntryPath === undefined
      ? await writeAuthoredModuleBundle(modulePath, options)
      : createFileImportSpecifier(graphEntryPath);
  try {
    return await import(specifier);
  } catch (error) {
    throw createAuthoredModuleEvaluationError(modulePath, error);
  }
}

async function writeAuthoredModuleBundle(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<string> {
  const code = await bundleAuthoredModuleCode(modulePath, options);
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);

  const bundleHash = createHash("sha1")
    .update(modulePath)
    .update("\0")
    .update(externalDependencies.join("\0"))
    .update("\0")
    .update(options.extension?.mountId ?? "")
    .update("\0")
    .update(code)
    .digest("hex");
  const bundleDirectoryPath = join(
    resolveAuthoredPackageRoot(modulePath),
    AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH,
  );
  const bundlePath = writeAuthoredModuleCacheFile(bundleDirectoryPath, `${bundleHash}.mjs`, code);
  const instance = options.extension?.evaluationId ?? "";
  return `${createFileImportSpecifier(bundlePath)}?v=${bundleHash}&instance=${encodeURIComponent(instance)}`;
}

function createInFlightModuleLoadKey(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): string {
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);

  return `${modulePath}\0${externalDependencies.join("\0")}\0${options.extension?.mountId ?? ""}\0${options.extension?.evaluationId ?? ""}\0${options.appRoot ?? ""}`;
}
