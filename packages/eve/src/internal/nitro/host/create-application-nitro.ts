import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createNitro } from "nitro/builder";
import type { Nitro } from "nitro/types";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import {
  resolvePackageSourceDirectoryPath,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import { resolveNitroBuildDirectory } from "#internal/application/paths.js";
import {
  createNitroArtifactsConfig,
  type NitroArtifactsConfigInput,
} from "#internal/nitro/host/artifacts-config.js";
import { createCompiledSandboxBackendPrunePlugin } from "#internal/nitro/host/compiled-sandbox-backend-prune-plugin.js";
import { configureNitroRoutes } from "#internal/nitro/host/configure-nitro-routes.js";
import { applyEveCronHandlerRoute } from "#internal/nitro/host/cron-handler-route.js";
import { createNitroBundlerConfig } from "#internal/nitro/host/nitro-bundler-config.js";
import { captureDevLiveVirtualModules } from "#internal/nitro/host/dev-live-virtual-modules.js";
import {
  createOptionalEngineDependencyPlugin,
  OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/nitro/host/optional-engine-dependency-plugin.js";
import { addNitroRoutingImportSpecifierPlugin } from "#internal/nitro/host/nitro-routing-import-specifier-plugin.js";
import { registerScheduleTaskHandlers } from "#internal/nitro/host/schedule-task-routes.js";
import { SERVER_EXTERNAL_PACKAGES } from "#internal/nitro/host/server-external-packages.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";
import { transformDynamicToolExecute } from "#internal/workflow-bundle/dynamic-tool-transform.js";
import { resolveCodeModeEnabled } from "#shared/code-mode.js";
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
const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  ...Object.keys(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME),
]);

function resolveWorkflowAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const specifier of WORKFLOW_ALIAS_SPECIFIERS) {
    aliases[specifier] = resolveWorkflowModulePath(specifier);
  }
  return aliases;
}

function resolveNitroPreset(dev: boolean): "vercel" | undefined {
  if (!dev && process.env.VERCEL) {
    return "vercel";
  }

  return undefined;
}

function includesApplicationSurface(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "app";
}

function includesWorkflowSurface(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "flow";
}

function includesWorkflowStepRegistrations(surface: NitroBuildSurface): boolean {
  return includesWorkflowSurface(surface);
}

/**
 * Reports whether any agent in the compiled graph runs in code mode, so the
 * host build only bundles the sandbox worker assets when they are needed.
 *
 * Each node resolves its own `experimental.codeMode` flag with the
 * `EVE_EXPERIMENTAL_CODE_MODE` env backstop, matching the runtime decision.
 */
function manifestEnablesCodeMode(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  // The Workflow tool reuses the code-mode runtime (QuickJS sandbox), so its
  // dependency must be bundled whenever any node enables code mode OR the
  // Workflow tool.
  return nodes.some(
    (node) =>
      resolveCodeModeEnabled(node.config.experimental?.codeMode) || node.workflowEnabled === true,
  );
}

function manifestHasWebSocketChannel(manifest: CompiledAgentManifest): boolean {
  return manifest.channels.some(
    (entry) => entry.kind === "channel" && entry.method === "WEBSOCKET",
  );
}

function resolveWorkflowStepEntrypointPath(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): string {
  return nitro.options.dev
    ? join(nitro.options.buildDir, "workflow", "steps.mjs")
    : join(preparedHost.workflowBuildDir, "steps.mjs");
}

function collectHostedTraceDependencies(
  preparedHost: PreparedApplicationHost,
  configuredOptionalEnginePackages: readonly string[],
): string[] {
  const agentNodes = [
    preparedHost.compileResult.manifest,
    ...preparedHost.compileResult.manifest.subagents.map((subagent) => subagent.agent),
  ];
  const configuredExternalDependencies = agentNodes.flatMap(
    (node) => node.config.build?.externalDependencies ?? [],
  );
  const merged = new Set<string>([
    ...FRAMEWORK_HOSTED_EXTERNAL_PACKAGES,
    // Optional engine packages (just-bash, microsandbox) join the
    // externalize-and-trace path only when the compiled sandbox config
    // selects their backend — the app's opt-in. Otherwise
    // createOptionalEngineDependencyPlugin pins them as plain externals
    // so a resolvable-but-unrequested install adds nothing to hosted
    // output.
    ...configuredOptionalEnginePackages,
    ...SERVER_EXTERNAL_PACKAGES,
    ...configuredExternalDependencies,
  ]);
  return [...merged].filter((dependencyName) => dependencyName !== EVE_PACKAGE_NAME);
}

/**
 * Collects the backend names every compiled sandbox in the graph (root
 * and subagents) selected, so the host build can make backend-aware
 * packaging decisions.
 */
function collectConfiguredSandboxBackendNames(manifest: CompiledAgentManifest): Set<string> {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return new Set(
    nodes
      .map((node) => node.sandbox?.backendName)
      .filter((backendName): backendName is string => typeof backendName === "string"),
  );
}

/**
 * Hosted Vercel builds can prune local sandbox backends only when the
 * app did not explicitly configure one. Omitted backends resolve through
 * `defaultSandbox()`, which selects Vercel on hosted Vercel and never
 * needs local runtime code there.
 */
export function shouldPruneLocalSandboxBackends(input: {
  readonly configuredBackendNames: ReadonlySet<string>;
  readonly preset: "vercel" | undefined;
}): boolean {
  return (
    input.preset === "vercel" &&
    ![...input.configuredBackendNames].some((backendName) =>
      LOCAL_SANDBOX_BACKEND_NAMES.has(backendName),
    )
  );
}

function createDevelopmentWatchOptions(appRoot: string): { ignored: string[] } | undefined {
  if (appRoot.length === 0) {
    return undefined;
  }

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
): void {
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

  nitro.hooks.hook("build:before", () => {
    cachedStepTransformTargets = null;
  });

  if (nitro.options.dev) {
    nitro.hooks.hook("dev:reload", () => {
      cachedStepTransformTargets = null;
    });
  }

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
): void {
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

  nitro.hooks.hook("build:before", () => {
    cachedStepTransformTargets = null;
  });

  if (nitro.options.dev) {
    nitro.hooks.hook("dev:reload", () => {
      cachedStepTransformTargets = null;
    });
  }

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

/**
 * Creates one configured Nitro instance for either production build or dev
 * hosting of an eve application.
 *
 * `surface` narrows the mounted routes for isolated production builds.
 * `outputDir` lets callers stage those isolated builds into separate Nitro
 * output roots before assembling the final hosted deployment.
 */
export async function createApplicationNitro(
  preparedHost: PreparedApplicationHost,
  dev: boolean,
  options: {
    outputDir?: string;
    surface?: NitroBuildSurface;
  } = {},
): Promise<Nitro> {
  const surface = options.surface ?? "all";
  // Dev mode never registers Nitro scheduled tasks. We do not want Nitro to
  // watch authored schedules and fire them on their cron expressions during
  // `eve dev`; the dev-only `POST /eve/v1/dev/schedules/:scheduleId` route
  // is the only dev-time entry point. Production builds always register
  // schedules.
  const shouldRegisterScheduleTasks =
    !dev && includesApplicationSurface(surface) && preparedHost.scheduleRegistrations.length > 0;
  const preset = resolveNitroPreset(dev);
  const configuredBackendNames = collectConfiguredSandboxBackendNames(
    preparedHost.compileResult.manifest,
  );
  const compiledSandboxBackendPrunePlugin = shouldPruneLocalSandboxBackends({
    configuredBackendNames,
    preset,
  })
    ? createCompiledSandboxBackendPrunePlugin()
    : null;
  const configuredOptionalEnginePackages: string[] = [];
  const unconfiguredOptionalEnginePackages: string[] = [];
  for (const [backendName, packageName] of Object.entries(
    OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
  )) {
    (configuredBackendNames.has(backendName)
      ? configuredOptionalEnginePackages
      : unconfiguredOptionalEnginePackages
    ).push(packageName);
  }
  const nitroBundlerPlugins = [
    compiledSandboxBackendPrunePlugin,
    createOptionalEngineDependencyPlugin(unconfiguredOptionalEnginePackages),
  ].filter((plugin) => plugin !== null);
  const nitroRolldownConfig = createNitroBundlerConfig(nitroBundlerPlugins);
  const nitroRollupConfig = createNitroBundlerConfig(nitroBundlerPlugins);
  const tracedAppDependencies = collectHostedTraceDependencies(
    preparedHost,
    configuredOptionalEnginePackages,
  );
  const nitroBuildDir = resolveNitroBuildDirectory(preparedHost.appRoot, surface);
  const websocketEnabled =
    includesApplicationSurface(surface) &&
    (dev || manifestHasWebSocketChannel(preparedHost.compileResult.manifest));
  const nitroPlugins: string[] = [];
  if (manifestEnablesCodeMode(preparedHost.compileResult.manifest)) {
    nitroPlugins.push(
      resolvePackageSourceFilePath(
        "src/internal/nitro/host/code-mode-runtime-dependency-plugin.ts",
      ),
    );
  }
  if (preparedHost.compiledArtifacts.instrumentationPluginPath !== undefined) {
    nitroPlugins.push(preparedHost.compiledArtifacts.instrumentationPluginPath);
  }
  nitroPlugins.push(preparedHost.compiledArtifacts.bootstrapPath);
  await prepareEveVersionedCacheDirectory(nitroBuildDir);
  const nitro = await createNitro(
    {
      _cli: {
        command: dev ? "dev" : "build",
      },
      buildDir: nitroBuildDir,
      dev,
      features: {
        websocket: websocketEnabled,
      },
      logLevel: dev ? 1 : undefined,
      output:
        options.outputDir === undefined
          ? undefined
          : {
              dir: options.outputDir,
            },
      preset,
      plugins: nitroPlugins,
      publicAssets: [],
      scanDirs: includesWorkflowStepRegistrations(surface)
        ? [resolvePackageSourceDirectoryPath("src/execution")]
        : undefined,
      rolldownConfig: nitroRolldownConfig,
      rollupConfig: nitroRollupConfig,
      rootDir: preparedHost.appRoot,
      serverDir: false,
      traceDeps: tracedAppDependencies,
      vercel: createEveVercelOptions(preset === "vercel" && includesApplicationSurface(surface)),
      watchOptions: dev ? createDevelopmentWatchOptions(preparedHost.appRoot) : undefined,
    },
    dev
      ? {
          watch: true,
        }
      : undefined,
  );
  await writeEveVersionedCacheMetadata(nitroBuildDir);

  addNitroRoutingImportSpecifierPlugin(nitro);
  if (dev) {
    captureDevLiveVirtualModules(nitro);
  }

  // Resolve bare `workflow/*` specifiers during Nitro's Rollup bundling so
  // pre-built workflow modules (whose imports target eve's installed copies)
  // resolve correctly in production builds where Node resolution from the
  // workflow cache directory is not available.
  if (includesWorkflowSurface(surface)) {
    const workflowAliases = resolveWorkflowAliases();
    for (const [specifier, resolvedPath] of Object.entries(workflowAliases)) {
      nitro.options.alias[specifier] = resolvedPath;
    }
    addWorkflowModuleSideEffectsPlugin(nitro, preparedHost.workflowBuildDir);
    patchWorkflowTransformExcludePath(nitro, preparedHost.workflowBuildDir);
  }
  if (includesWorkflowStepRegistrations(surface)) {
    const stepEntrypointPath = resolveWorkflowStepEntrypointPath(nitro, preparedHost);
    addNitroStepModuleSideEffectsPlugin(nitro, {
      stepEntrypointPath,
    });
    addNitroStepTransformPlugin(nitro, {
      stepEntrypointPath,
    });
  }
  // Dynamic tool transform runs unconditionally — it needs to hoist
  // execute functions for all tool files, not just workflow step targets.
  addDynamicToolTransformPlugin(nitro);

  if (preparedHost.compiledArtifacts.instrumentationSourcePath !== undefined) {
    addInstrumentationModuleSideEffectsPlugin(
      nitro,
      preparedHost.compiledArtifacts.instrumentationSourcePath,
    );
  }

  // Prevent Nitro from re-bundling the pre-built workflow bundle in dev
  // mode. `steps.mjs` is now a source entry that Nitro must still bundle
  // so its imported TypeScript step files are transformed.
  if (dev && includesWorkflowSurface(surface)) {
    const workflowBuildDir = preparedHost.workflowBuildDir;
    const externalWorkflowModules = new Set([
      normalizePath(join(workflowBuildDir, "workflows.mjs")),
    ]);

    nitro.hooks.hook("rollup:before", (_nitro, config) => {
      const existingExternal = config.external;
      config.external = (id: string, ...rest: unknown[]) => {
        if (externalWorkflowModules.has(normalizePath(id))) {
          return true;
        }
        if (typeof existingExternal === "function") {
          return (
            existingExternal as (id: string, ...rest: unknown[]) => boolean | null | undefined
          )(id, ...rest);
        }
        return undefined;
      };
    });
  }

  if (shouldRegisterScheduleTasks) {
    // Replace Vercel's default `/_vercel/cron` path with an unguessable
    // per-build route so users do not need to configure `CRON_SECRET` to
    // protect the cron endpoint. No-op when the Vercel preset is not in
    // use (e.g. dev mode), where the cron route is never registered.
    applyEveCronHandlerRoute(nitro);

    const artifactsConfig: NitroArtifactsConfigInput = createNitroArtifactsConfig({
      appRoot: preparedHost.appRoot,
      dev: nitro.options.dev,
    });
    registerScheduleTaskHandlers(nitro, {
      artifactsConfig,
      dispatchModulePath: resolvePackageSourceFilePath(
        "src/internal/nitro/routes/schedule-task.ts",
      ),
      registrations: preparedHost.scheduleRegistrations,
    });
  }
  await configureNitroRoutes(nitro, preparedHost, {
    surface,
  });
  if (includesWorkflowStepRegistrations(surface)) {
    await addNitroStepNoExternals(nitro, resolveWorkflowStepEntrypointPath(nitro, preparedHost));
  }

  return nitro;
}
