import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  stringifyEsmImportSpecifier,
  stringifyNitroDataImportSpecifier,
} from "#internal/application/import-specifier.js";

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
import { resolveRolldownPackageDir } from "#internal/bundler/rolldown.js";
import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";
import { createHostNoExternals } from "#internal/nitro/host/externals-policy.js";
import { createHostPlugins } from "#internal/nitro/host/host-plugins.js";
import { type HostNitroRoutes, renderHostRoutes } from "#internal/nitro/host/host-routes.js";
import type { HostRuntimePlugin, HostSpec } from "#internal/nitro/host/host-spec.js";
import { createInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import {
  createRuntimePluginSource,
  EVE_RUNTIME_PLUGIN_ID,
} from "#internal/nitro/host/runtime-plugin.js";
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
const TIMEZONE_SCHEDULES_PLUGIN_ID = "#eve/timezone-schedules.mjs";

// Nitro gates preset behavior on this date. Pinning it keeps the build date
// and COMPATIBILITY_DATE env out of eve's host; move it with the Nitro version.
const EVE_NITRO_COMPATIBILITY_DATE = "2026-11-03";

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
export async function createHostNitro(
  spec: HostSpec,
  options: { readonly onBuildInputs?: (ids: readonly string[]) => void } = {},
): Promise<Nitro> {
  const { locations } = spec;
  const workflowArtifacts = await new WorkflowBundleBuilder({
    agentName: spec.agentName,
    appRoot: locations.appRoot,
    authoredWorkflowModules: locations.compiledArtifacts.authoredWorkflowModules,
    compiledArtifactsBootstrapPath: locations.compiledArtifacts.bootstrapPath,
    outDir: locations.workflowBuildDir,
    inlineSourcemap: spec.development,
    rootDir: resolvePackageRoot(),
  }).build();
  options.onBuildInputs?.(workflowArtifacts.inputs ?? []);
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
    timezoneRunner: spec.runtimePlugins.includes("timezone-schedules"),
  });
  const timezoneSchedulesConfigPath = join(locations.buildDir, "eve-timezone-schedules.json");
  const timezoneSchedulesPlugin = spec.runtimePlugins.includes("timezone-schedules")
    ? createTimezoneSchedulesPlugin(timezoneSchedulesConfigPath)
    : undefined;

  const nitro = await createNitro(
    toNitroConfig(spec, {
      onBuildInputs: options.onBuildInputs,
      routes,
      skillFilesPlugin,
      timezoneSchedulesPlugin,
      workflowArtifacts,
    }),
    createNitroLoadOptions(locations.buildDir),
  );
  if (timezoneSchedulesPlugin !== undefined) {
    if (nitro.options.preset !== "node-server") {
      await nitro.close().catch(() => undefined);
      throw new Error(
        `Schedule timezones require the node-server or Vercel host. The "${nitro.options.preset}" Nitro preset is not supported. Build for Node and run with eve start, or deploy to Vercel.`,
      );
    }
    await writeFile(
      timezoneSchedulesConfigPath,
      JSON.stringify(spec.routes.scheduleTasks.filter((task) => task.timezone !== undefined)),
    );
  }
  return nitro;
}

function createTimezoneSchedulesPlugin(configPath: string): string {
  return [
    `import data from ${stringifyNitroDataImportSpecifier("text", configPath)};`,
    `import { installTimezoneSchedules } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/nitro/host/timezone-schedules-runtime.ts"))};`,
    "export default function timezoneSchedulesPlugin(app) { installTimezoneSchedules(app, JSON.parse(data)); }",
  ].join("\n");
}

function toNitroConfig(
  spec: HostSpec,
  built: {
    readonly onBuildInputs: ((ids: readonly string[]) => void) | undefined;
    readonly routes: HostNitroRoutes;
    readonly skillFilesPlugin: string | undefined;
    readonly timezoneSchedulesPlugin: string | undefined;
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
    buildPlugins: createHostPlugins({
      appRoot: locations.appRoot,
      authoredPackageRoot: spec.authored.packageRoot,
      // A source checkout resolves eve's vendored modules through the `eve-source`
      // condition, which a natively loaded module would not use.
      loadVendoredDependenciesNatively: spec.development && !import.meta.url.endsWith(".ts"),
      externals: spec.externals,
      onBuildInputs: built.onBuildInputs,
      extensionMounts: spec.extensionMounts,
      extensionOverridePaths: spec.extensionOverridePaths,
      instrumentationEntryPlugin: instrumentationEntry?.plugin,
      instrumentationSourcePaths: compiledArtifacts.instrumentationSourcePaths,
      hostBundledPackageRoots: compiledArtifacts.hostBundledPackageRoots,
      runtimeModules: [compiledArtifacts.bootstrapPath, compiledArtifacts.workflowWorldPluginPath],
      workflowArtifacts: built.workflowArtifacts,
    }),
    compatibilityDate: EVE_NITRO_COMPATIBILITY_DATE,
    // eve builds with its own Rolldown and never lets Nitro install a package
    // into the app; a missing one fails the build with the install command.
    deps: { install: false, paths: { rolldown: resolveRolldownPackageDir() } },
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
    plugins: [
      EVE_RUNTIME_PLUGIN_ID,
      ...spec.runtimePlugins.map((plugin) => resolveRuntimePluginPath(plugin, compiledArtifacts)),
    ],
    preset: spec.preset,
    publicAssets: [],
    // Nitro would otherwise serve an app-root `index.html` and `server.*` as
    // catch-alls in front of eve's routes.
    renderer: false,
    rolldownConfig: {
      // eve's own plugins dominate the timings, which the app cannot act on.
      checks: { bundlerTimings: false },
      onLog: onVendoredDependencyLog,
      // Keep dependency filtering out of Rolldown's JS callback bridge.
      output: { sourcemapIgnoreList: /node_modules/ },
      // ESM output has no CommonJS path globals. Rolldown replaces only free
      // references, so no chunk code crosses into JS and a module's own
      // declaration is left alone.
      transform: {
        define: { __dirname: "import.meta.dirname", __filename: "import.meta.filename" },
      },
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
    // Rolldown's `tsconfig` option above resolves authored aliases.
    typescript: { tsconfigPaths: false },
    vercel: spec.vercel,
    virtual: {
      ...built.routes.virtual,
      [EVE_RUNTIME_PLUGIN_ID]: createRuntimePluginSource(spec.runtime, compiledArtifacts),
      ...(built.timezoneSchedulesPlugin !== undefined && {
        [TIMEZONE_SCHEDULES_PLUGIN_ID]: built.timezoneSchedulesPlugin,
      }),
      ...(built.skillFilesPlugin !== undefined && {
        [SKILL_FILES_PLUGIN_ID]: built.skillFilesPlugin,
      }),
    },
  };
}

const EVE_RUNTIME_PLUGIN_PATHS = {
  "connection-drain": "src/internal/nitro/host/connection-drain-plugin.ts",
  "local-schedules": "src/internal/nitro/host/local-schedules-runtime-plugin.ts",
  "sandbox-shutdown": "src/internal/nitro/host/sandbox-shutdown-plugin.ts",
} as const;

function resolveRuntimePluginPath(
  plugin: HostRuntimePlugin,
  compiledArtifacts: HostSpec["locations"]["compiledArtifacts"],
): string {
  switch (plugin) {
    case "instrumentation":
      if (compiledArtifacts.instrumentationPluginPath === undefined) {
        throw new Error("Instrumented host has no instrumentation plugin.");
      }
      return compiledArtifacts.instrumentationPluginPath;
    case "skill-files":
      return SKILL_FILES_PLUGIN_ID;
    case "timezone-schedules":
      return TIMEZONE_SCHEDULES_PLUGIN_ID;
    default:
      return resolvePackageSourceFilePath(EVE_RUNTIME_PLUGIN_PATHS[plugin]);
  }
}
