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
import { ROUTE_APP_ID } from "#internal/nitro/host/route-handlers.js";
import {
  MAIN_ENTRY_NAME,
  type HostRuntimePlugin,
  type HostSpec,
} from "#internal/nitro/host/host-spec.js";
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

const EVE_NITRO_BUILDER = "rolldown";
const TIMEZONE_SCHEDULES_PLUGIN_ID = "#eve/timezone-schedules.mjs";

const EVE_NITRO_COMPATIBILITY_DATE = "2026-11-03";

function createNitroLoadOptions(buildDir: string): LoadConfigOptions {
  return {
    c12: { configFile: join(buildDir, "nitro.config"), packageJson: false, rcFile: false },
    dotenv: false,
  };
}

export async function createHostNitro(spec: HostSpec): Promise<Nitro> {
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
    toNitroConfig(spec, { routes, skillFilesPlugin, timezoneSchedulesPlugin, workflowArtifacts }),
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
    readonly routes: HostNitroRoutes;
    readonly skillFilesPlugin: string | undefined;
    readonly timezoneSchedulesPlugin: string | undefined;
    readonly workflowArtifacts: WorkflowArtifacts;
  },
): NitroConfig {
  const { compiledArtifacts, ...locations } = spec.locations;
  const nodeless = spec.exportConditions !== undefined && !spec.exportConditions.includes("node");
  const instrumentationEntry =
    compiledArtifacts.instrumentationPluginPath === undefined
      ? undefined
      : createInstrumentationEntry(compiledArtifacts.instrumentationPluginPath, {
          appImports: Object.keys(spec.entries).length > 0,
          platformEntry: spec.entry,
        });
  const engineEntries = instrumentationEntry !== undefined && Object.keys(spec.entries).length > 0;

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
      loadVendoredDependenciesNatively: spec.development && !import.meta.url.endsWith(".ts"),
      externals: spec.externals,
      extensionMounts: spec.extensionMounts,
      extensionOverridePaths: spec.extensionOverridePaths,
      instrumentationEntryPlugin: instrumentationEntry?.plugin,
      instrumentationSourcePaths: compiledArtifacts.instrumentationSourcePaths,
      hostBundledPackageRoots: compiledArtifacts.hostBundledPackageRoots,
      runtimeModules: [
        compiledArtifacts.bootstrapPath,
        compiledArtifacts.platformModulePath,
        compiledArtifacts.workflowWorldPluginPath,
      ],
      workflowArtifacts: built.workflowArtifacts,
    }),
    compatibilityDate: EVE_NITRO_COMPATIBILITY_DATE,
    deps: { install: false, paths: { rolldown: resolveRolldownPackageDir() } },
    dev: spec.development,
    ...(spec.exportConditions !== undefined && {
      exportConditions: nodeless ? [...spec.exportConditions, "!node"] : [...spec.exportConditions],
    }),
    features: { websocket: spec.websocket },
    ...(instrumentationEntry && {
      inlineDynamicImports: instrumentationEntry.inlineDynamicImports,
    }),
    logLevel: spec.development ? 1 : undefined,
    logging: spec.development ? undefined : { compressedSizes: false },
    modules: instrumentationEntry ? [instrumentationEntry.module] : [],
    noExternals: createHostNoExternals(built.workflowArtifacts.stepTargets),
    output: { dir: locations.outputDir },
    plugins: [
      EVE_RUNTIME_PLUGIN_ID,
      ...spec.runtimePlugins.map((plugin) => resolveRuntimePluginPath(plugin, spec)),
    ],
    preset: spec.preset,
    publicAssets: [],
    renderer: false,
    rolldownConfig: {
      checks: { bundlerTimings: false },
      onLog: onVendoredDependencyLog,
      output: {
        sourcemapIgnoreList: /node_modules/,
        ...(engineEntries && { entryFileNames: "[name].mjs" }),
      },
      ...(engineEntries && {
        input: { [MAIN_ENTRY_NAME]: instrumentationEntry.hostEntry, ...spec.entries },
      }),
      transform: {
        define: { __dirname: "import.meta.dirname", __filename: "import.meta.filename" },
      },
      tsconfig: spec.authored.tsconfig,
      ...(nodeless && { platform: "neutral" as const }),
      ...(!spec.development && { experimental: { attachDebugInfo: "none" as const } }),
    },
    rootDir: locations.appRoot,
    scanDirs: [],
    serverDir: false,
    serverEntry: false,
    traceDeps: [...spec.externals.traceDeps],
    typescript: { tsconfigPaths: false },
    vercel: spec.vercel,
    virtual: {
      ...built.routes.virtual,
      [EVE_RUNTIME_PLUGIN_ID]: createRuntimePluginSource(spec.runtime, compiledArtifacts),
      ...(built.timezoneSchedulesPlugin !== undefined && {
        [TIMEZONE_SCHEDULES_PLUGIN_ID]: built.timezoneSchedulesPlugin,
      }),
      ...(spec.runtimePlugins.includes("sandbox-shutdown") && {
        [SANDBOX_SHUTDOWN_PLUGIN_ID]: createAppPlugin(
          resolvePackageSourceFilePath("src/internal/nitro/host/sandbox-shutdown-plugin.ts"),
        ),
      }),
      ...(spec.runtimePlugins.includes("local-schedules") && {
        [LOCAL_SCHEDULES_PLUGIN_ID]: createAppPlugin(
          resolvePackageSourceFilePath(spec.localSchedulesPluginModulePath),
        ),
      }),
      ...(built.skillFilesPlugin !== undefined && {
        [SKILL_FILES_PLUGIN_ID]: built.skillFilesPlugin,
      }),
    },
  };
}

const EVE_RUNTIME_PLUGIN_PATHS = {
  "connection-drain": "src/internal/nitro/host/connection-drain-plugin.ts",
} as const;

const SANDBOX_SHUTDOWN_PLUGIN_ID = "#eve/sandbox-shutdown.mjs";
const LOCAL_SCHEDULES_PLUGIN_ID = "#eve/local-schedules.mjs";

function createAppPlugin(pluginPath: string): string {
  return [
    `import { app } from ${JSON.stringify(ROUTE_APP_ID)};`,
    `import plugin from ${stringifyEsmImportSpecifier(pluginPath)};`,
    "export default function eveAppPlugin(nitroApp) { plugin(nitroApp, app); }",
  ].join("\n");
}

function resolveRuntimePluginPath(plugin: HostRuntimePlugin, spec: HostSpec): string {
  const { compiledArtifacts } = spec.locations;
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
    case "sandbox-shutdown":
      return SANDBOX_SHUTDOWN_PLUGIN_ID;
    case "local-schedules":
      return LOCAL_SCHEDULES_PLUGIN_ID;
    default:
      return resolvePackageSourceFilePath(EVE_RUNTIME_PLUGIN_PATHS[plugin]);
  }
}
