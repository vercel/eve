import type { NitroConfig } from "nitro/types";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import {
  resolvePackageSourceDirectoryPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createCompiledSandboxBackendPrunePlugin } from "#internal/nitro/host/compiled-sandbox-backend-prune-plugin.js";
import { createNitroBundlerConfig } from "#internal/nitro/host/nitro-bundler-config.js";
import {
  createOptionalEngineDependencyPlugin,
  OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/nitro/host/optional-engine-dependency-plugin.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";

/**
 * Packages eve pulls into hosted output that must remain external so Nitro can
 * trace their platform-specific native binaries instead of bundling them.
 */
const FRAMEWORK_HOSTED_EXTERNAL_PACKAGES: readonly string[] = ["@napi-rs/keyring"];
const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  ...Object.keys(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME),
]);

type EveNitroContributionMode = "development" | "production";

type CreateEveNitroContributionOptions =
  | {
      readonly host?: "embedded" | "standalone";
      readonly mode: "development";
      readonly preset: undefined;
      readonly surface: "all";
    }
  | {
      readonly host?: "embedded" | "standalone";
      readonly mode: "production";
      readonly preset: "vercel" | undefined;
      readonly surface: NitroBuildSurface;
    };

export interface EveNitroConfigDelta {
  readonly features: {
    readonly websocket: boolean;
  };
  readonly plugins: readonly string[];
  readonly rolldownConfig: NonNullable<NitroConfig["rolldownConfig"]>;
  readonly rollupConfig: NonNullable<NitroConfig["rollupConfig"]>;
  readonly scanDirs: readonly string[];
  readonly traceDeps: readonly (string | RegExp)[];
}

/**
 * Internal, host-policy-free description of eve-owned Nitro requirements.
 *
 * Pre-creation configuration is an additive delta consumed by
 * `mergeEveNitroConfig`. Routes and build hooks are installed separately for a
 * lifecycle that has already established whether Nitro is being created for
 * standalone development or for a production build.
 */
export interface EveNitroContribution<
  Mode extends EveNitroContributionMode = EveNitroContributionMode,
> {
  readonly applicationRoutes: boolean;
  readonly configDelta: EveNitroConfigDelta;
  readonly mode: Mode;
  readonly preparedHost: PreparedApplicationHost;
  readonly surface: NitroBuildSurface;
  readonly workflowRoutes: boolean;
}

function includesApplicationSurface(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "app";
}

function includesWorkflowSurface(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "flow";
}

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
  configuredOptionalEnginePackages: readonly string[],
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
    // Optional engine packages join the externalize-and-trace path only when
    // the compiled sandbox config selects their backend.
    ...configuredOptionalEnginePackages,
    ...configuredExternalDependencies,
  ]);
  return [...merged].filter((dependencyName) => dependencyName !== EVE_PACKAGE_NAME);
}

function collectConfiguredSandboxBackendNames(manifest: CompiledAgentManifest): Set<string> {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return new Set(
    nodes
      .map((node) => node.sandbox?.backendName)
      .filter((backendName): backendName is string => typeof backendName === "string"),
  );
}

/**
 * Hosted Vercel builds can prune local sandbox backends only when the app did
 * not explicitly configure one.
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

function createContributionBundlerConfiguration(
  preparedHost: PreparedApplicationHost,
  preset: "vercel" | undefined,
) {
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
  const extensionScopePlugin = createExtensionScopePlugin(
    (preparedHost.compileResult.manifest.extensionMounts ?? []).map((mount) => ({
      sourceRoot: mount.sourceRoot,
      packageNamespace: mount.packageNamespace,
    })),
  );
  const nitroBundlerPlugins = [
    compiledSandboxBackendPrunePlugin,
    createOptionalEngineDependencyPlugin(unconfiguredOptionalEnginePackages),
    extensionScopePlugin,
  ].filter((plugin) => plugin !== null);

  return {
    nitroRolldownConfig: createNitroBundlerConfig(nitroBundlerPlugins) as NonNullable<
      NitroConfig["rolldownConfig"]
    >,
    nitroRollupConfig: createNitroBundlerConfig(nitroBundlerPlugins) as NonNullable<
      NitroConfig["rollupConfig"]
    >,
    tracedAppDependencies: collectHostedTraceDependencies(
      preparedHost,
      configuredOptionalEnginePackages,
    ),
  };
}

function createContributionPlugins(
  preparedHost: PreparedApplicationHost,
  mode: EveNitroContributionMode,
): string[] {
  const plugins = [
    preparedHost.compiledArtifacts.bootstrapPath,
    preparedHost.compiledArtifacts.workflowWorldPluginPath,
  ];
  if (manifestEnablesWorkflow(preparedHost.compileResult.manifest)) {
    plugins.push(
      resolvePackageSourceFilePath("src/internal/nitro/host/workflow-sandbox-runtime-plugin.ts"),
    );
  }
  if (preparedHost.compiledArtifacts.instrumentationPluginPath !== undefined) {
    plugins.push(preparedHost.compiledArtifacts.instrumentationPluginPath);
  }
  if (mode === "production") {
    plugins.push(
      resolvePackageSourceFilePath("src/internal/nitro/host/sandbox-shutdown-plugin.ts"),
    );
  }

  return plugins;
}

export function createEveNitroContribution<const Options extends CreateEveNitroContributionOptions>(
  preparedHost: PreparedApplicationHost,
  options: Options,
): EveNitroContribution<Options["mode"]> {
  const applicationRoutes = includesApplicationSurface(options.surface);
  const workflowRoutes = includesWorkflowSurface(options.surface);
  const bundler = createContributionBundlerConfiguration(preparedHost, options.preset);

  return {
    applicationRoutes,
    configDelta: {
      features: {
        websocket:
          (options.mode === "development" && options.host !== "embedded") ||
          (applicationRoutes && manifestHasWebSocketChannel(preparedHost.compileResult.manifest)),
      },
      plugins: createContributionPlugins(preparedHost, options.mode),
      rolldownConfig: bundler.nitroRolldownConfig,
      rollupConfig: bundler.nitroRollupConfig,
      scanDirs: workflowRoutes ? [resolvePackageSourceDirectoryPath("src/execution")] : [],
      traceDeps: bundler.tracedAppDependencies,
    },
    mode: options.mode,
    preparedHost,
    surface: options.surface,
    workflowRoutes,
  };
}
