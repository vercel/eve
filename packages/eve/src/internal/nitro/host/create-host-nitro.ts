import { join } from "node:path";

import { createNitro } from "nitro/builder";
import type { LoadConfigOptions, Nitro, NitroConfig } from "nitro/types";

import {
  resolvePackageRoot,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
  WORKFLOW_MODULE_SPECIFIERS,
} from "#internal/application/package.js";
import {
  createDevelopmentNitroArtifactsConfig,
  createProductionNitroArtifactsConfig,
} from "#internal/nitro/host/artifacts-config.js";
import { createHostNoExternals } from "#internal/nitro/host/externals-policy.js";
import { createHostPlugins } from "#internal/nitro/host/host-plugins.js";
import { type HostNitroRoutes, renderHostRoutes } from "#internal/nitro/host/host-routes.js";
import type { HostRuntimePlugin, HostSpec } from "#internal/nitro/host/host-spec.js";
import { createInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import { onNitroBundlerLog } from "#internal/nitro/host/nitro-bundler-config.js";
import {
  SKILL_FILES_PLUGIN_ID,
  writeSkillFilesPlugin,
} from "#internal/nitro/host/skill-files-plugin.js";
import {
  type WorkflowArtifacts,
  WorkflowBundleBuilder,
} from "#internal/workflow-bundle/builder.js";

const INSTRUMENTATION_ALIAS_PATHS = {
  "eve/instrumentation": "src/public/instrumentation/index.ts",
  "eve/instrumentation/otel": "src/public/instrumentation/otel.ts",
} as const;

// Nitro picks the Vite builder when the app root has a `vite.config` that calls
// `nitro(`, which is the case when a TanStack Start host shares its root with
// the agent. eve bundles its own runtime and never builds through the host's Vite.
const EVE_NITRO_BUILDER = "rolldown";

// Nitro gates preset behavior on this date. Pinning it keeps the build date
// and COMPATIBILITY_DATE env out of eve's host; move it with the Nitro version.
const EVE_NITRO_COMPATIBILITY_DATE = "2026-09-03";

/**
 * eve owns its host config and env loading, so Nitro must not merge the app
 * root's `nitro.config`, `.nitrorc`, `package.json` `nitro` key, or `.env`
 * files into eve's host. c12 has no switch for the main config file, so its
 * lookup points into eve's build directory, which never holds one.
 */
function createNitroLoadOptions(buildDir: string): LoadConfigOptions {
  return {
    c12: { configFile: join(buildDir, "nitro.config"), packageJson: false, rcFile: false },
    dotenv: false,
  };
}

/**
 * Creates eve's Nitro host: one isolated candidate for `eve dev`, or one
 * production build. The returned Nitro is configured entirely by its config.
 */
export async function createHostNitro(spec: HostSpec): Promise<Nitro> {
  const { locations } = spec;
  const workflowArtifacts = await new WorkflowBundleBuilder({
    agentName: spec.agentName,
    appRoot: locations.appRoot,
    authoredWorkflowModules: locations.compiledArtifacts.authoredWorkflowModules,
    compiledArtifactsBootstrapPath: locations.compiledArtifacts.bootstrapPath,
    outDir: locations.workflowBuildDir,
    rootDir: resolvePackageRoot(),
  }).build();
  const skillFilesPlugin = spec.runtimePlugins.includes("skill-files")
    ? await writeSkillFilesPlugin({
        skills: spec.skills,
        skillsRoot: locations.skillsRoot,
        stagingDirectory: join(locations.buildDir, "eve-skill-files"),
      })
    : undefined;
  const routes = await renderHostRoutes(spec.routes, {
    artifactsConfig: spec.development
      ? createDevelopmentNitroArtifactsConfig({
          appRoot: locations.appRoot,
          configuredWorld: spec.world,
        })
      : createProductionNitroArtifactsConfig(locations.appRoot),
    artifactsConfigPath: join(locations.buildDir, "eve-route-config.json"),
    workflowArtifacts,
    workflowWorldPluginPath: locations.compiledArtifacts.workflowWorldPluginPath,
  });

  return await createNitro(
    toNitroConfig(spec, { routes, skillFilesPlugin, workflowArtifacts }),
    createNitroLoadOptions(locations.buildDir),
  );
}

function toNitroConfig(
  spec: HostSpec,
  built: {
    readonly routes: HostNitroRoutes;
    readonly skillFilesPlugin: string | undefined;
    readonly workflowArtifacts: WorkflowArtifacts;
  },
): NitroConfig {
  const { compiledArtifacts, ...locations } = spec.locations;
  const instrumentationEntry =
    compiledArtifacts.instrumentationPluginPath === undefined
      ? undefined
      : createInstrumentationEntry(compiledArtifacts.instrumentationPluginPath);

  return {
    ...built.routes,
    alias: {
      ...Object.fromEntries(
        WORKFLOW_MODULE_SPECIFIERS.map((specifier) => [
          specifier,
          resolveWorkflowModulePath(specifier),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(INSTRUMENTATION_ALIAS_PATHS).map(([specifier, sourcePath]) => [
          specifier,
          resolvePackageSourceFilePath(sourcePath),
        ]),
      ),
    },
    buildDir: locations.buildDir,
    builder: EVE_NITRO_BUILDER,
    compatibilityDate: EVE_NITRO_COMPATIBILITY_DATE,
    dev: spec.development,
    features: { websocket: spec.websocket },
    ...(instrumentationEntry && {
      inlineDynamicImports: instrumentationEntry.inlineDynamicImports,
    }),
    logLevel: spec.development ? 1 : undefined,
    // Gzipping every output file only annotates the build log's file tree.
    logging: spec.development ? undefined : { compressedSizes: false },
    modules: instrumentationEntry ? [instrumentationEntry.module] : [],
    noExternals: createHostNoExternals(built.workflowArtifacts.stepTargets),
    output: { dir: locations.outputDir },
    plugins: spec.runtimePlugins.map((plugin) =>
      resolveRuntimePluginPath(plugin, compiledArtifacts),
    ),
    preset: spec.preset,
    publicAssets: [],
    // Nitro would otherwise serve an app-root `index.html` and `server.*` as
    // catch-alls in front of eve's routes.
    renderer: false,
    rolldownConfig: {
      onLog: onNitroBundlerLog,
      // Keep dependency filtering out of Rolldown's JS callback bridge.
      output: { sourcemapIgnoreList: /node_modules/ },
      plugins: createHostPlugins({
        appRoot: locations.appRoot,
        authoredPackageRoot: spec.authored.packageRoot,
        externals: spec.externals,
        extensionMounts: spec.extensionMounts,
        extensionOverridePaths: spec.extensionOverridePaths,
        instrumentationEntryPlugin: instrumentationEntry?.plugin,
        instrumentationSourcePaths: compiledArtifacts.instrumentationSourcePaths,
        workflowArtifacts: built.workflowArtifacts,
      }),
      tsconfig: spec.authored.tsconfig,
      // Region comments contain invocation-random scratch paths, not runtime inputs.
      ...(!spec.development && { experimental: { attachDebugInfo: "none" as const } }),
    },
    rootDir: locations.appRoot,
    // eve registers every handler, plugin, and task explicitly.
    scanDirs: [],
    serverDir: false,
    serverEntry: false,
    traceDeps: [...spec.externals.traceDeps],
    vercel: spec.vercel,
    virtual: {
      ...built.routes.virtual,
      ...(built.skillFilesPlugin !== undefined && {
        [SKILL_FILES_PLUGIN_ID]: built.skillFilesPlugin,
      }),
    },
  };
}

const EVE_RUNTIME_PLUGIN_PATHS = {
  "local-schedules": "src/internal/nitro/host/local-schedules-runtime-plugin.ts",
  "local-tracing": "src/internal/nitro/host/local-tracing-runtime-plugin.ts",
  "sandbox-shutdown": "src/internal/nitro/host/sandbox-shutdown-plugin.ts",
  "workflow-sandbox": "src/internal/nitro/host/workflow-sandbox-runtime-plugin.ts",
} as const;

function resolveRuntimePluginPath(
  plugin: HostRuntimePlugin,
  compiledArtifacts: HostSpec["locations"]["compiledArtifacts"],
): string {
  switch (plugin) {
    case "compiled-artifacts":
      return compiledArtifacts.bootstrapPath;
    case "instrumentation":
      if (compiledArtifacts.instrumentationPluginPath === undefined) {
        throw new Error("Instrumented host has no instrumentation plugin.");
      }
      return compiledArtifacts.instrumentationPluginPath;
    case "skill-files":
      return SKILL_FILES_PLUGIN_ID;
    case "workflow-world":
      return compiledArtifacts.workflowWorldPluginPath;
    default:
      return resolvePackageSourceFilePath(EVE_RUNTIME_PLUGIN_PATHS[plugin]);
  }
}
