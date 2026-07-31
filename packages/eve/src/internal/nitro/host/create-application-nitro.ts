import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createNitro } from "nitro/builder";
import type { Nitro } from "nitro/types";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import {
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import { createProductionNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { createCompiledSandboxProviderPrunePlugin } from "#internal/nitro/host/local-sandbox-provider-prune-plugin.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import {
  configureDevelopmentNitroRoutes,
  configureProductionNitroRoutes,
} from "#internal/nitro/host/configure-nitro-routes.js";
import { applyEveCronHandlerRoute } from "#internal/nitro/host/cron-handler-route.js";
import { createNitroBundlerConfig } from "#internal/nitro/host/nitro-bundler-config.js";
import {
  createOptionalSandboxProviderDependencyPlugin,
  OPTIONAL_SANDBOX_PROVIDER_PACKAGES,
} from "#internal/nitro/host/optional-sandbox-provider-dependency-plugin.js";
import { addNitroRoutingImportSpecifierPlugin } from "#internal/nitro/host/nitro-routing-import-specifier-plugin.js";
import { registerScheduleTaskHandlers } from "#internal/nitro/host/schedule-task-routes.js";
import type {
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";
import { transformDynamicToolExecute } from "#internal/workflow-bundle/dynamic-tool-transform.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";

/**
 * Bare `workflow/*` specifiers that appear in pre-built workflow bundles.
 * Nitro's alias system resolves these at Rollup build time for production,
 * replacing the import-rewriting post-processing that previously ran after
 * each builder invocation.
 */
const WORKFLOW_ALIAS_SPECIFIERS = [
  "workflow",
  "workflow/api",
  "workflow/errors",
  "workflow/internal/builtins",
  "workflow/internal/private",
  "workflow/runtime",
] as const;
const WORKFLOW_TRANSFORM_PATCHED = Symbol("eve.workflow-transform-patched");
const WORKFLOW_CACHE_PATH_FRAGMENT = "/.eve/workflow-cache/";

/**
 * Packages eve itself pulls into hosted application output that must stay
 * external so Nitro/rolldown does not try to inline platform-specific
 * `.node` binaries (which would fail with a UTF-8 decode error).
 *
 * `@napi-rs/keyring` reaches the hosted bundle transitively through
 * `@vercel/oidc` → `@vercel/cli-auth` and ships native `keyring.<platform>.node`
 * binaries. App authors should not have to know about this; the framework
 * traces it into `server/node_modules` automatically.
 */
const FRAMEWORK_HOSTED_EXTERNAL_PACKAGES: readonly string[] = ["@napi-rs/keyring"];
const LOCAL_SANDBOX_PROVIDERS = new Set([
  "docker",
  ...Object.keys(OPTIONAL_SANDBOX_PROVIDER_PACKAGES),
]);

function resolveWorkflowAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const specifier of WORKFLOW_ALIAS_SPECIFIERS) {
    aliases[specifier] = resolveWorkflowModulePath(specifier);
  }
  return aliases;
}

function resolveProductionNitroPreset(): "vercel" | undefined {
  return process.env.VERCEL ? "vercel" : undefined;
}

/** Whether any agent needs the dynamic Workflow sandbox runtime. */
function manifestEnablesWorkflow(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.workflowTool !== undefined);
}

function manifestHasWebSocketChannel(manifest: CompiledAgentManifest): boolean {
  return manifest.channels.some(
    (entry) => entry.kind === "channel" && entry.method === "WEBSOCKET",
  );
}

function collectHostedTraceDependencies(
  preparedHost: PreparedApplicationHost,
  configuredOptionalSandboxProviderPackages: readonly string[],
): string[] {
  const agentNodes = [
    preparedHost.compileResult.manifest,
    ...preparedHost.compileResult.manifest.subagents.map((subagent) => subagent.agent),
  ];
  const configuredExternalDependencies = agentNodes.flatMap(
    (node) => node.config.build?.externalDependencies ?? [],
  );
  // Nitro already classifies known native and non-bundleable packages through
  // its nf3 database. traceDeps is only for eve-owned or author-configured
  // additions to that upstream policy.
  const merged = new Set<string>([
    ...FRAMEWORK_HOSTED_EXTERNAL_PACKAGES,
    // Optional sandbox provider packages (just-bash, microsandbox) join the
    // externalize-and-trace path only when the compiled sandbox config
    // selects their provider — the app's opt-in. Otherwise
    // createOptionalSandboxProviderDependencyPlugin pins them as plain externals
    // so a resolvable-but-unrequested install adds nothing to hosted
    // output.
    ...configuredOptionalSandboxProviderPackages,
    ...configuredExternalDependencies,
  ]);
  return [...merged].filter((dependencyName) => dependencyName !== EVE_PACKAGE_NAME);
}

/**
 * Conservatively includes every local provider when an authored definition can
 * choose a sandbox dynamically at runtime.
 */
function collectConfiguredSandboxProviderNames(manifest: CompiledAgentManifest): Set<string> {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.sandbox !== null) ? new Set(LOCAL_SANDBOX_PROVIDERS) : new Set();
}

/**
 * Hosted Vercel builds can prune local providers only when no authored sandbox
 * definition can select one at runtime.
 */
export function shouldPruneLocalSandboxProviders(input: {
  readonly configuredProviders: ReadonlySet<string>;
  readonly preset: "vercel" | undefined;
}): boolean {
  return (
    input.preset === "vercel" &&
    ![...input.configuredProviders].some((provider) => LOCAL_SANDBOX_PROVIDERS.has(provider))
  );
}

function createDevelopmentWatchOptions(appRoot: string): { ignored: string[] } {
  return {
    // eve's authored-source watcher owns app code rebuilds. If Nitro/Rollup
    // also watches those files it can reload the worker while a workflow
    // stream is waiting on a tool result, which surfaces as ECONNRESET.
    ignored: [appRoot, join(appRoot, "**")],
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function stripPathQueryAndHash(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutoff =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  return cutoff === -1 ? path : path.slice(0, cutoff);
}

function stripFileSystemPrefix(path: string): string {
  return path.startsWith("/@fs/") ? path.slice("/@fs".length) : path;
}

function resolveNitroModuleComparisonPath(rootDir: string, path: string): string {
  if (path.startsWith("file://")) {
    return normalizePath(stripFileSystemPrefix(stripPathQueryAndHash(fileURLToPath(path))));
  }

  if (isAbsolute(path)) {
    return normalizePath(stripFileSystemPrefix(stripPathQueryAndHash(path)));
  }

  return normalizePath(stripFileSystemPrefix(stripPathQueryAndHash(resolve(rootDir, path))));
}

function isWorkflowBundlePath(path: string, normalizedWorkflowBuildDir: string): boolean {
  const normalizedPath = normalizePath(path);

  return (
    normalizedPath.startsWith(normalizedWorkflowBuildDir) ||
    normalizedPath.includes(WORKFLOW_CACHE_PATH_FRAGMENT)
  );
}

function normalizeStepTransformComparisonPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function parseImportedModuleSpecifiers(source: string): string[] {
  const importSpecifierPattern = /^\s*import\s+(?:.+?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
  const importedSpecifiers: string[] = [];

  for (const match of source.matchAll(importSpecifierPattern)) {
    const importedSpecifier = match[1];
    if (importedSpecifier !== undefined) {
      importedSpecifiers.push(importedSpecifier);
    }
  }

  return importedSpecifiers;
}

function resolveNitroImportPath(
  rootDir: string,
  importSpecifier: string,
  importer?: string,
): string | null {
  if (importSpecifier.startsWith("workflow")) {
    return resolveWorkflowModulePath(importSpecifier);
  }

  if (
    importSpecifier.startsWith(".") ||
    importSpecifier.startsWith("/") ||
    importSpecifier.startsWith("file://")
  ) {
    const importerDirectory =
      importer === undefined
        ? rootDir
        : dirname(resolveNitroModuleComparisonPath(rootDir, importer));

    return resolveNitroModuleComparisonPath(importerDirectory, importSpecifier);
  }

  return null;
}

async function collectNitroStepTransformTargets(
  stepEntrypointPath: string,
  rootDir: string,
): Promise<Set<string>> {
  const stepEntrypointSource = await readFile(stepEntrypointPath, "utf8");
  const stepTransformTargets = new Set<string>();

  for (const importSpecifier of parseImportedModuleSpecifiers(stepEntrypointSource)) {
    const resolvedImportPath = resolveNitroImportPath(rootDir, importSpecifier, stepEntrypointPath);

    if (resolvedImportPath !== null) {
      stepTransformTargets.add(normalizeStepTransformComparisonPath(resolvedImportPath));
    }
  }

  return stepTransformTargets;
}

async function addNitroStepNoExternals(nitro: Nitro, stepEntrypointPath: string): Promise<void> {
  if (nitro.options.noExternals === true) {
    return;
  }

  let stepTransformTargets: Set<string>;

  try {
    stepTransformTargets = await collectNitroStepTransformTargets(
      stepEntrypointPath,
      nitro.options.rootDir,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
  const existingNoExternals = Array.isArray(nitro.options.noExternals)
    ? [...nitro.options.noExternals]
    : [];

  nitro.options.noExternals = [...new Set([...existingNoExternals, ...stepTransformTargets])];
}

function createRelativeTransformFilename(workingDir: string, path: string): string {
  const packageRelativePath = createPackageRelativeTransformFilename(path);
  if (packageRelativePath !== undefined) {
    return packageRelativePath;
  }

  const normalizedWorkingDir = normalizePath(workingDir).replace(/\/$/, "");
  const normalizedPath = normalizePath(path);
  const lowerWorkingDir = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();

  if (lowerPath.startsWith(`${lowerWorkingDir}/`)) {
    return normalizedPath.slice(normalizedWorkingDir.length + 1);
  }

  if (lowerPath === lowerWorkingDir) {
    return ".";
  }

  let relativePath = relative(normalizedWorkingDir, normalizedPath).replaceAll("\\", "/");

  if (relativePath.startsWith("../")) {
    relativePath = relativePath
      .split("/")
      .filter((part) => part !== "..")
      .join("/");
  }

  if (relativePath.includes(":") || relativePath.startsWith("/")) {
    const filename = normalizedPath.split("/").pop();
    return filename === undefined || filename.length === 0 ? "unknown.ts" : filename;
  }

  return relativePath;
}

function createPackageRelativeTransformFilename(path: string): string | undefined {
  const normalizedPackageRoot = normalizePath(resolvePackageRoot()).replace(/\/$/, "");
  const normalizedPath = normalizePath(path);
  const lowerPackageRoot = normalizedPackageRoot.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const packageSourcePrefix = `${normalizedPackageRoot}/src/`;
  const lowerPackageSourcePrefix = `${lowerPackageRoot}/src/`;
  const packageDistSourcePrefix = `${normalizedPackageRoot}/dist/src/`;
  const lowerPackageDistSourcePrefix = `${lowerPackageRoot}/dist/src/`;

  if (lowerPath.startsWith(lowerPackageSourcePrefix)) {
    return `src/${normalizedPath.slice(packageSourcePrefix.length)}`;
  }

  if (lowerPath.startsWith(lowerPackageDistSourcePrefix)) {
    return `src/${normalizedPath.slice(packageDistSourcePrefix.length)}`;
  }

  return undefined;
}

function addWorkflowModuleSideEffectsPlugin(nitro: Nitro, workflowBuildDir: string): void {
  const workflowBundleDirectories = [
    workflowBuildDir,
    join(nitro.options.buildDir, "workflow"),
  ].map((directoryPath) => resolveNitroModuleComparisonPath(nitro.options.rootDir, directoryPath));

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:workflow-module-side-effects",
      resolveId(source: string, importer: string | undefined) {
        const resolvedSource =
          resolveNitroImportPath(nitro.options.rootDir, source, importer) ??
          resolveNitroModuleComparisonPath(nitro.options.rootDir, source);

        if (
          !workflowBundleDirectories.some((workflowBundleDirectory) =>
            isWorkflowBundlePath(resolvedSource, workflowBundleDirectory),
          )
        ) {
          return null;
        }

        return {
          id: resolvedSource,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });
}

function addNitroStepModuleSideEffectsPlugin(
  nitro: Nitro,
  input: {
    stepEntrypointPath: string;
  },
): () => void {
  let cachedStepTransformTargets: Set<string> | null = null;

  const getStepTransformTargets = async (): Promise<Set<string>> => {
    if (cachedStepTransformTargets !== null) {
      return cachedStepTransformTargets;
    }

    cachedStepTransformTargets = await collectNitroStepTransformTargets(
      input.stepEntrypointPath,
      nitro.options.rootDir,
    );
    return cachedStepTransformTargets;
  };

  const clearCachedStepTransformTargets = () => {
    cachedStepTransformTargets = null;
  };
  nitro.hooks.hook("build:before", clearCachedStepTransformTargets);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:workflow-step-module-side-effects",
      async resolveId(source: string, importer?: string) {
        const resolvedSource = resolveNitroImportPath(nitro.options.rootDir, source, importer);

        if (resolvedSource === null) {
          return null;
        }

        const stepTransformTargets = await getStepTransformTargets();
        if (!stepTransformTargets.has(normalizeStepTransformComparisonPath(resolvedSource))) {
          return null;
        }

        return {
          id: resolvedSource,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });

  return clearCachedStepTransformTargets;
}

/**
 * Transforms package-owned execution sources in step mode so the generated
 * Nitro `steps.mjs` entry can import raw source files while still registering
 * durable step handlers with the Workflow runtime.
 */
function addNitroStepTransformPlugin(
  nitro: Nitro,
  input: {
    stepEntrypointPath: string;
  },
): () => void {
  let cachedStepTransformTargets: Set<string> | null = null;

  const getStepTransformTargets = async (): Promise<Set<string>> => {
    if (cachedStepTransformTargets !== null) {
      return cachedStepTransformTargets;
    }

    cachedStepTransformTargets = await collectNitroStepTransformTargets(
      input.stepEntrypointPath,
      nitro.options.rootDir,
    );
    return cachedStepTransformTargets;
  };

  const clearCachedStepTransformTargets = () => {
    cachedStepTransformTargets = null;
  };
  nitro.hooks.hook("build:before", clearCachedStepTransformTargets);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      async transform(code: string, id: string) {
        const stepTransformTargets = await getStepTransformTargets();

        const resolvedId = resolveNitroModuleComparisonPath(nitro.options.rootDir, id);

        if (!stepTransformTargets.has(normalizeStepTransformComparisonPath(resolvedId))) {
          return null;
        }

        const result = await applyWorkflowTransform(
          createRelativeTransformFilename(nitro.options.rootDir, resolvedId),
          code,
          "step",
          resolvedId,
          nitro.options.rootDir,
        );

        return {
          code: result.code,
          map: null,
        };
      },
      name: "eve:workflow-step-transform",
    });
  });

  return clearCachedStepTransformTargets;
}

/**
 * Adds the dynamic tool transform plugin that hoists execute functions
 * from defineDynamic event handlers to module scope. Runs
 * unconditionally for all tool files regardless of workflow mode.
 */
function addDynamicToolTransformPlugin(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      async transform(code: string, id: string) {
        if (!id.includes("/tools/")) return null;
        const result = await transformDynamicToolExecute(id, code);
        if (result === null) return null;
        return { code: result.code, map: null };
      },
      name: "eve:dynamic-tool-transform",
    });
  });
}

/**
 * Marks the authored instrumentation module as side-effectful so Nitro's final
 * Rollup/Rolldown pass preserves its eager evaluation from the generated
 * instrumentation plugin.
 */
function addInstrumentationModuleSideEffectsPlugin(
  nitro: Nitro,
  instrumentationModulePath: string,
): void {
  const normalizedInstrumentationModulePath = normalizePath(instrumentationModulePath);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:instrumentation-module-side-effects",
      resolveId(source: string) {
        if (normalizePath(source) !== normalizedInstrumentationModulePath) {
          return null;
        }

        return {
          id: source,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });
}

/**
 * Extends the Workflow Nitro transform exclusion list to include eve's
 * package-owned workflow cache directory.
 *
 * Without this patch, the Workflow transform can re-process the already-built
 * `steps.mjs` bundle and strip top-level step registrations from hosted output.
 */
function patchWorkflowTransformExcludePath(nitro: Nitro, workflowBuildDir: string): void {
  const normalizedWorkflowBuildDir = normalizePath(workflowBuildDir);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    for (const plugin of config.plugins) {
      if (plugin === null || plugin === undefined || typeof plugin !== "object") {
        continue;
      }

      const workflowTransformPlugin = plugin as {
        [WORKFLOW_TRANSFORM_PATCHED]?: true;
        name?: string;
        transform?: (this: unknown, code: string, id: string, ...rest: unknown[]) => unknown;
      };
      if (workflowTransformPlugin.name !== "workflow:transform") {
        continue;
      }
      if (workflowTransformPlugin[WORKFLOW_TRANSFORM_PATCHED] === true) {
        continue;
      }
      if (typeof workflowTransformPlugin.transform !== "function") {
        continue;
      }

      const originalTransform = workflowTransformPlugin.transform;
      workflowTransformPlugin.transform = function (
        this: unknown,
        code: string,
        id: string,
        ...rest: unknown[]
      ): unknown {
        if (isWorkflowBundlePath(id, normalizedWorkflowBuildDir)) {
          return null;
        }

        return originalTransform.call(this, code, id, ...rest);
      };
      workflowTransformPlugin[WORKFLOW_TRANSFORM_PATCHED] = true;
    }
  });
}

function createApplicationNitroBundlerConfiguration(
  preparedHost: PreparedApplicationHost,
  preset: "vercel" | undefined,
) {
  const configuredProviders = collectConfiguredSandboxProviderNames(
    preparedHost.compileResult.manifest,
  );
  const compiledSandboxProviderPrunePlugin = shouldPruneLocalSandboxProviders({
    configuredProviders,
    preset,
  })
    ? createCompiledSandboxProviderPrunePlugin()
    : null;
  const configuredOptionalSandboxProviderPackages: string[] = [];
  const unconfiguredOptionalSandboxProviderPackages: string[] = [];
  for (const [provider, packageName] of Object.entries(OPTIONAL_SANDBOX_PROVIDER_PACKAGES)) {
    (configuredProviders.has(provider)
      ? configuredOptionalSandboxProviderPackages
      : unconfiguredOptionalSandboxProviderPackages
    ).push(packageName);
  }
  const extensionScopePlugin = createExtensionScopePlugin(
    (preparedHost.compileResult.manifest.extensionMounts ?? []).map((mount) => ({
      sourceRoot: mount.sourceRoot,
      packageNamespace: mount.packageNamespace,
    })),
  );
  const nitroBundlerPlugins = [
    compiledSandboxProviderPrunePlugin,
    createOptionalSandboxProviderDependencyPlugin(unconfiguredOptionalSandboxProviderPackages),
    extensionScopePlugin,
  ].filter((plugin) => plugin !== null);
  const nitroRolldownConfig = createNitroBundlerConfig(nitroBundlerPlugins);
  const nitroRollupConfig = createNitroBundlerConfig(nitroBundlerPlugins);
  const tracedAppDependencies = collectHostedTraceDependencies(
    preparedHost,
    configuredOptionalSandboxProviderPackages,
  );

  return {
    nitroRolldownConfig,
    nitroRollupConfig,
    tracedAppDependencies,
  };
}

function createApplicationNitroPlugins(preparedHost: PreparedApplicationHost): string[] {
  const nitroPlugins = [
    preparedHost.compiledArtifacts.bootstrapPath,
    preparedHost.compiledArtifacts.workflowWorldPluginPath,
  ];
  if (manifestEnablesWorkflow(preparedHost.compileResult.manifest)) {
    nitroPlugins.push(
      resolvePackageSourceFilePath("src/internal/nitro/host/workflow-sandbox-runtime-plugin.ts"),
    );
  }
  if (preparedHost.compiledArtifacts.instrumentationPluginPath !== undefined) {
    nitroPlugins.push(preparedHost.compiledArtifacts.instrumentationPluginPath);
  }

  return nitroPlugins;
}

function configureSharedApplicationNitro(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): void {
  addNitroRoutingImportSpecifierPlugin(nitro);
  const workflowAliases = resolveWorkflowAliases();
  for (const [specifier, resolvedPath] of Object.entries(workflowAliases)) {
    nitro.options.alias[specifier] = resolvedPath;
  }
  addWorkflowModuleSideEffectsPlugin(nitro, preparedHost.workflowBuildDir);
  patchWorkflowTransformExcludePath(nitro, preparedHost.workflowBuildDir);

  addDynamicToolTransformPlugin(nitro);

  if (preparedHost.compiledArtifacts.instrumentationSourcePath !== undefined) {
    addInstrumentationModuleSideEffectsPlugin(
      nitro,
      preparedHost.compiledArtifacts.instrumentationSourcePath,
    );
  }
}

function configureNitroStepPlugins(nitro: Nitro, stepEntrypointPath: string): Array<() => void> {
  return [
    addNitroStepModuleSideEffectsPlugin(nitro, { stepEntrypointPath }),
    addNitroStepTransformPlugin(nitro, { stepEntrypointPath }),
  ];
}

function externalizeDevelopmentWorkflowBundle(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): void {
  const externalWorkflowModules = new Set([
    normalizePath(join(preparedHost.workflowBuildDir, "workflows.mjs")),
  ]);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    const existingExternal = config.external;
    config.external = (id: string, ...rest: unknown[]) => {
      if (externalWorkflowModules.has(normalizePath(id))) {
        return true;
      }
      if (typeof existingExternal === "function") {
        return (existingExternal as (id: string, ...rest: unknown[]) => boolean | null | undefined)(
          id,
          ...rest,
        );
      }
      return undefined;
    };
  });
}

/**
 * Creates one isolated Nitro host candidate for `eve dev`.
 */
export async function createDevelopmentApplicationNitro(
  preparedHost: PreparedDevelopmentApplicationHost,
): Promise<Nitro> {
  const nitroBuildDir = preparedHost.workspace.nitroBuildDir;
  const bundler = createApplicationNitroBundlerConfiguration(preparedHost, undefined);
  const plugins = createApplicationNitroPlugins(preparedHost);
  if (preparedHost.compiledArtifacts.instrumentationPluginPath === undefined) {
    plugins.unshift(
      resolvePackageSourceFilePath("src/internal/nitro/host/local-tracing-runtime-plugin.ts"),
    );
  }

  await prepareEveVersionedCacheDirectory(nitroBuildDir);
  const nitro = await createNitro(
    {
      _cli: { command: "dev" },
      buildDir: nitroBuildDir,
      dev: true,
      features: { websocket: true },
      logLevel: 1,
      output: { dir: preparedHost.workspace.nitroOutputDir },
      plugins,
      publicAssets: [],
      scanDirs: [resolvePackageSourceDirectoryPath("src/execution")],
      rolldownConfig: bundler.nitroRolldownConfig,
      rollupConfig: bundler.nitroRollupConfig,
      rootDir: preparedHost.appRoot,
      serverDir: false,
      traceDeps: bundler.tracedAppDependencies,
      vercel: createEveVercelOptions({
        agentName: preparedHost.compileResult.manifest.config.name,
        enabled: false,
      }),
      watchOptions: createDevelopmentWatchOptions(preparedHost.appRoot),
    },
    { watch: true },
  );
  await writeEveVersionedCacheMetadata(nitroBuildDir);

  const stepEntrypointPath = join(nitro.options.buildDir, "workflow", "steps.mjs");
  configureSharedApplicationNitro(nitro, preparedHost);
  const clearStepTransformCaches = configureNitroStepPlugins(nitro, stepEntrypointPath);
  nitro.hooks.hook("dev:reload", () => {
    for (const clearCache of clearStepTransformCaches) {
      clearCache();
    }
  });
  externalizeDevelopmentWorkflowBundle(nitro, preparedHost);
  await configureDevelopmentNitroRoutes(nitro, preparedHost);
  await addNitroStepNoExternals(nitro, stepEntrypointPath);

  return nitro;
}

interface ProductionApplicationNitroOptions {
  readonly buildDir: string;
  readonly outputDir: string;
  /**
   * Agent's resolved public route prefix, baked into the Vercel flow
   * function's environment for callback-URL minting behind a per-agent mount.
   */
  readonly publicRoutePrefix?: string;
}

/**
 * Creates a build-mode Nitro host for one production build. Every route group
 * (application, workflow, schedules) is registered in the same host; on Vercel
 * the workflow flow route additionally becomes its own queue-triggered function
 * through the preset's `functionRules`. `buildDir`/`outputDir` place all
 * bundler state inside the invocation-owned build workspace.
 */
export async function createProductionApplicationNitro(
  preparedHost: PreparedApplicationHost,
  options: ProductionApplicationNitroOptions,
): Promise<Nitro> {
  const preset = resolveProductionNitroPreset();
  const bundler = createApplicationNitroBundlerConfiguration(preparedHost, preset);
  const nitroPlugins = createApplicationNitroPlugins(preparedHost);
  nitroPlugins.push(
    resolvePackageSourceFilePath("src/internal/nitro/host/sandbox-shutdown-plugin.ts"),
  );

  await prepareEveVersionedCacheDirectory(options.buildDir);
  const nitro = await createNitro({
    _cli: { command: "build" },
    buildDir: options.buildDir,
    dev: false,
    features: {
      websocket: manifestHasWebSocketChannel(preparedHost.compileResult.manifest),
    },
    output: { dir: options.outputDir },
    preset,
    plugins: nitroPlugins,
    publicAssets: [],
    scanDirs: [resolvePackageSourceDirectoryPath("src/execution")],
    rolldownConfig: bundler.nitroRolldownConfig,
    rollupConfig: bundler.nitroRollupConfig,
    rootDir: preparedHost.appRoot,
    serverDir: false,
    traceDeps: bundler.tracedAppDependencies,
    vercel: createEveVercelOptions({
      agentName: preparedHost.compileResult.manifest.config.name,
      enabled: preset === "vercel",
      publicRoutePrefix: options.publicRoutePrefix,
    }),
  });
  await writeEveVersionedCacheMetadata(options.buildDir);

  configureSharedApplicationNitro(nitro, preparedHost);
  configureNitroStepPlugins(nitro, join(preparedHost.workflowBuildDir, "steps.mjs"));

  if (preparedHost.scheduleRegistrations.length > 0) {
    applyEveCronHandlerRoute(nitro);
    const artifactsConfig = createProductionNitroArtifactsConfig();
    registerScheduleTaskHandlers(nitro, {
      artifactsConfig,
      dispatchModulePath: resolvePackageSourceFilePath(
        "src/internal/nitro/routes/schedule-task.ts",
      ),
      registrations: preparedHost.scheduleRegistrations,
    });
  }

  await configureProductionNitroRoutes(nitro, preparedHost);
  await addNitroStepNoExternals(nitro, join(preparedHost.workflowBuildDir, "steps.mjs"));
  return nitro;
}
