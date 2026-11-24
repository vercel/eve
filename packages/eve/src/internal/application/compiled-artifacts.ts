import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { ROUTE_CONFIG_ID } from "#internal/nitro/host/route-handlers.js";
import { join } from "node:path";

import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { compiledAgentManifestSchema } from "#compiler/manifest-schema.js";
import {
  stringifyEsmImportSpecifier,
  stringifyNitroDataImportSpecifier,
} from "#internal/application/import-specifier.js";
import { modelMetadataSchema } from "#internal/model-catalog.js";
import type { BundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  resolvePackageCompiledFilePath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { buildPackageUserAgent } from "#internal/user-agent.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";
import { sandboxPreparedArtifactsManifestSchema } from "#shared/sandbox-prepared-artifacts.js";
import {
  prepareAuthoredRuntimeModules,
  type PreparedAuthoredRuntimeModules,
} from "#internal/authored-runtime-modules.js";
import {
  readMaterializedAuthoredModuleIndex,
  type MaterializedInstrumentation,
} from "#internal/materialized-authored-modules.js";
import { type InstrumentationLayout } from "#internal/instrumentation-layout.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import { resolveWorkflowWorldImport } from "#internal/workflow/world-target.js";
import { BUILD_DEPLOYMENT_ID_PLACEHOLDER } from "#internal/nitro/host/build-deployment-id.js";

export type BuiltInWorkflowWorldTarget = "local" | "vercel";

const PLATFORM_MODULE_FILE = "compiled-artifacts-platform.mjs";

export interface GeneratedInstrumentationLayout {
  readonly kind: "directory";
  readonly slots: readonly string[];
}

export interface GeneratedCompiledArtifactsFiles {
  readonly authoredWorkflowModules?: AuthoredWorkflowModules;
  bootstrapPath: string;
  platformModulePath: string;
  workflowWorldPluginPath: string;
  instrumentationPluginPath?: string;
  instrumentationLayout?: GeneratedInstrumentationLayout;
  instrumentationSourcePaths?: readonly string[];
  hostBundledPackageRoots?: readonly string[];
}

export async function writeCompiledArtifactsFiles(input: {
  compileResult: CompileAgentResult;
  defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
  deferInstrumentationSetup?: boolean;
  outDir: string;
  platformModule: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const platformModulePath = join(input.outDir, PLATFORM_MODULE_FILE);
  const processPath = join(input.outDir, "compiled-artifacts-process.mjs");
  const moduleMapPath = join(input.outDir, "compiled-artifacts-module-map.mjs");
  const instrumentationPluginPath = join(input.outDir, "compiled-artifacts-instrumentation.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const dataPath = await writeCompiledArtifactsData(input);
  const prepared = await prepareAuthoredRuntimeModules({
    appRoot: input.compileResult.project.appRoot,
    manifest: input.compileResult.manifest,
    moduleMapPath: input.compileResult.paths.moduleMapPath,
    hostBundled: true,
  });

  await writeFile(moduleMapPath, prepared.moduleMapCode);
  await writeFile(platformModulePath, createPlatformModuleSource(input.platformModule));
  await writeFile(processPath, createProcessSource(dataPath, platformModulePath));
  await writeFile(
    bootstrapPath,
    createCompiledArtifactsBootstrapSource({
      moduleMapImportPath: moduleMapPath,
      processImportPath: processPath,
    }),
  );
  await writeFile(
    workflowWorldPluginPath,
    createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: bootstrapPath,
      configuredWorld: input.compileResult.manifest.config.experimental?.workflow?.world,
      defaultWorld: input.defaultWorkflowWorld,
    }),
  );

  const generatedArtifacts: GeneratedCompiledArtifactsFiles = {
    authoredWorkflowModules: prepared.authoredWorkflowModules,
    bootstrapPath,
    hostBundledPackageRoots: prepared.hostBundledPackageRoots,
    platformModulePath,
    workflowWorldPluginPath,
  };

  const instrumentationLayout = await writePreparedInstrumentation({
    instrumentation: prepared.instrumentation,
    outDir: input.outDir,
  });
  await writeFile(
    instrumentationPluginPath,
    createInstrumentationPluginSource({
      agentName: input.compileResult.manifest.config.name,
      deferSetup: input.deferInstrumentationSetup === true,
      layout: instrumentationLayout,
      platformModulePath,
    }),
  );
  generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
  generatedArtifacts.instrumentationLayout = generatedInstrumentationLayout(instrumentationLayout);
  generatedArtifacts.instrumentationSourcePaths =
    instrumentationSourcePathsOf(instrumentationLayout);

  return generatedArtifacts;
}

export async function writeCompiledArtifactsData(input: {
  compileResult: CompileAgentResult;
  outDir: string;
}): Promise<string> {
  const dataPath = join(input.outDir, "compiled-artifacts-data.json");
  const sandboxPreparedArtifacts = sandboxPreparedArtifactsManifestSchema.parse(
    JSON.parse(await readFile(input.compileResult.paths.sandboxPreparedArtifactsPath, "utf8")),
  );
  const modelMetadata = modelMetadataSchema.parse(
    JSON.parse(await readFile(input.compileResult.paths.modelMetadataPath, "utf8")),
  );

  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    dataPath,
    JSON.stringify({
      manifest: compiledAgentManifestSchema.parse(input.compileResult.manifest),
      metadata: input.compileResult.metadata,
      modelMetadata,
      sandboxPreparedArtifacts,
    } satisfies Omit<BundledCompiledArtifacts, "moduleMap">),
  );
  return dataPath;
}

async function writePreparedInstrumentation(input: {
  readonly instrumentation: PreparedAuthoredRuntimeModules["instrumentation"];
  readonly outDir: string;
}): Promise<InstrumentationLayout> {
  const writeOne = async (sourceId: string, code: string): Promise<string> => {
    const path = join(input.outDir, `compiled-artifacts-instrumentation-${sourceId}.mjs`);
    await writeFile(path, code);
    return path;
  };

  const modulePathsBySlot: Record<string, string> = {};
  for (const [slot, code] of Object.entries(input.instrumentation.moduleCodeBySlot)) {
    modulePathsBySlot[slot] = await writeOne(slot, code);
  }
  return { kind: "directory", modulePathsBySlot };
}

function instrumentationSourcePathsOf(layout: InstrumentationLayout): readonly string[] {
  return Object.values(layout.modulePathsBySlot);
}

export async function writeDevelopmentCompiledArtifactsFiles(input: {
  readonly authoredWorkflowModules?: AuthoredWorkflowModules;
  readonly compileResult: CompileAgentResult;
  readonly outDir: string;
  readonly platformModule: string;
  readonly runtimeAppRoot: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const platformModulePath = join(input.outDir, PLATFORM_MODULE_FILE);
  const instrumentationPluginPath = join(input.outDir, "compiled-artifacts-instrumentation.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const materializedIndex = await readMaterializedAuthoredModuleIndex(input.runtimeAppRoot);

  if (materializedIndex === undefined) {
    throw new Error(`Development generation at "${input.runtimeAppRoot}" is not materialized.`);
  }

  await mkdir(input.outDir, { recursive: true });
  await writeFile(platformModulePath, createPlatformModuleSource(input.platformModule));
  await writeFile(
    bootstrapPath,
    createDevelopmentCompiledArtifactsBootstrapSource(
      input.compileResult.manifest.config.name,
      platformModulePath,
    ),
  );
  await writeFile(
    workflowWorldPluginPath,
    createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: bootstrapPath,
      configuredWorld: input.compileResult.manifest.config.experimental?.workflow?.world,
    }),
  );

  const generatedArtifacts: GeneratedCompiledArtifactsFiles = {
    authoredWorkflowModules: input.authoredWorkflowModules,
    bootstrapPath,
    platformModulePath,
    workflowWorldPluginPath,
  };

  if (materializedIndex.instrumentation !== undefined) {
    const layout = await copyMaterializedInstrumentation({
      instrumentation: materializedIndex.instrumentation,
      outDir: input.outDir,
      runtimeAppRoot: input.runtimeAppRoot,
    });

    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        deferSetup: false,
        layout,
        platformModulePath,
      }),
    );
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationLayout = generatedInstrumentationLayout(layout);
    generatedArtifacts.instrumentationSourcePaths = instrumentationSourcePathsOf(layout);
  }

  return generatedArtifacts;
}

function generatedInstrumentationLayout(
  layout: InstrumentationLayout,
): GeneratedInstrumentationLayout {
  return { kind: "directory", slots: Object.keys(layout.modulePathsBySlot) };
}

async function copyMaterializedInstrumentation(input: {
  readonly instrumentation: MaterializedInstrumentation;
  readonly outDir: string;
  readonly runtimeAppRoot: string;
}): Promise<InstrumentationLayout> {
  const compileRoot = join(input.runtimeAppRoot, ".eve", "compile");
  const copyOne = async (sourceId: string, modulePath: string): Promise<string> => {
    const destination = join(input.outDir, `compiled-artifacts-instrumentation-${sourceId}.mjs`);
    await copyFile(join(compileRoot, modulePath), destination);
    return destination;
  };

  const modulePathsBySlot: Record<string, string> = {};
  for (const [slot, modulePath] of Object.entries(input.instrumentation.modulePathsBySlot)) {
    modulePathsBySlot[slot] = await copyOne(slot, modulePath);
  }
  return { kind: "directory", modulePathsBySlot };
}

function createPlatformModuleSource(platformModule: string): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    `import platform from ${stringifyEsmImportSpecifier(platformModule)};`,
    `import { selectProcessPlatform } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/platform/process.ts"))};`,
    "",
    "selectProcessPlatform(platform);",
    "export default platform;",
    "",
  ].join("\n");
}

function createDevelopmentCompiledArtifactsBootstrapSource(
  agentName: string,
  platformModulePath: string,
): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    bootProcessImportLine(),
    platformImportLine(platformModulePath),
    "",
    `await bootProcess({ agentName: ${JSON.stringify(agentName)}, platform }, "artifacts");`,
    "",
  ].join("\n");
}

function bootProcessImportLine(): string {
  return `import { bootProcess } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/runtime/lifecycle.ts"))};`;
}

function platformImportLine(platformModulePath: string): string {
  return `import platform from ${stringifyEsmImportSpecifier(platformModulePath)};`;
}

function createProcessSource(dataPath: string, platformModulePath: string): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    bootProcessImportLine(),
    platformImportLine(platformModulePath),
    `import data from ${stringifyNitroDataImportSpecifier("text", dataPath)};`,
    "",
    "export const artifacts = JSON.parse(data);",
    "await bootProcess(",
    "  { agentName: artifacts.manifest.config.name, platform },",
    '  "queue-namespace",',
    ");",
    "",
  ].join("\n");
}

function createCompiledArtifactsBootstrapSource(input: {
  moduleMapImportPath: string;
  processImportPath: string;
}): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    `import { artifacts } from ${stringifyEsmImportSpecifier(input.processImportPath)};`,
    `import moduleMap from ${stringifyEsmImportSpecifier(input.moduleMapImportPath)};`,
    bootProcessImportLine(),
    "",
    "await bootProcess(",
    "  { agentName: artifacts.manifest.config.name, artifacts: { ...artifacts, moduleMap } },",
    '  "artifacts",',
    ");",
    "",
  ].join("\n");
}

function bootImportLines(): string[] {
  return [
    `import artifactsConfig from ${JSON.stringify(ROUTE_CONFIG_ID)};`,
    `import { resolveNitroCompiledArtifactsSource } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/nitro/routes/runtime-artifacts.ts"))};`,
    `import { start } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/runtime/start.ts"))};`,
    `import { workflowEngine } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/execution/workflow-host/engine.ts"))};`,
  ];
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => (line === "" ? line : `        ${line}`))
    .join("\n");
}

interface WorkflowWorldWiring {
  readonly moduleImportSpecifier: string;
  readonly extraImportLines: readonly string[];
  readonly createWorldSource: string;
}

function resolveWorkflowWorldWiring(packageName: string): WorkflowWorldWiring {
  if (packageName === "@workflow/world-local") {
    const dataDirectoryImportSpecifier = stringifyEsmImportSpecifier(
      resolvePackageSourceFilePath("src/internal/workflow/local-world-data-directory.ts"),
    );
    const deliveryTimeoutsImportSpecifier = stringifyEsmImportSpecifier(
      resolvePackageSourceFilePath("src/internal/workflow/local-world-delivery-timeouts.ts"),
    );
    const queueAuthImportSpecifier = stringifyEsmImportSpecifier(
      resolvePackageSourceFilePath("src/internal/workflow/local-world-queue-auth.ts"),
    );
    const moduleImportSpecifier = resolvePackageCompiledFilePath(
      `src/compiled/${packageName}/index.js`,
    );
    const importLines = `
import { applyLocalWorkflowWorldDeliveryTimeoutDefaults } from ${deliveryTimeoutsImportSpecifier};
import { assertLocalWorkflowQueueAuthEnforced } from ${queueAuthImportSpecifier};
import { resolveLocalWorkflowWorldDataDirectory } from ${dataDirectoryImportSpecifier};`.trimStart();
    const createWorldSource = `
assertLocalWorkflowQueueAuthEnforced();
applyLocalWorkflowWorldDeliveryTimeoutDefaults();
const workflowWorld = await workflowWorldModule.createWorld({
  dataDir: resolveLocalWorkflowWorldDataDirectory(process.cwd()),
  recoverActiveRuns: true,
});`.trimStart();
    return {
      moduleImportSpecifier,
      extraImportLines: importLines.split("\n"),
      createWorldSource,
    };
  }

  if (packageName === "@workflow/world-vercel") {
    const moduleImportSpecifier = resolvePackageCompiledFilePath(
      `src/compiled/${packageName}/index.js`,
    );
    const createWorldSource = `
const workflowWorld = await workflowWorldModule.createWorld({
  headers: { "User-Agent": ${JSON.stringify(buildPackageUserAgent())} },
});`.trimStart();
    return {
      moduleImportSpecifier,
      extraImportLines: [],
      createWorldSource,
    };
  }

  const workflowRuntimeImportSpecifier = stringifyEsmImportSpecifier(
    resolvePackageCompiledFilePath("src/compiled/@workflow/core/runtime.js"),
  );
  return {
    moduleImportSpecifier: packageName,
    extraImportLines: [`import { createWorldFromModule } from ${workflowRuntimeImportSpecifier};`],
    createWorldSource: "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
  };
}

export function createWorkflowWorldPluginSource(input: {
  compiledArtifactsBootstrapPath: string;
  configuredWorld: AgentWorkflowWorldDefinition | undefined;
  defaultWorld: BuiltInWorkflowWorldTarget;
}): string {
  const targetWorld = input.configuredWorld ?? input.defaultWorld;
  const packageName = resolveWorkflowWorldImport(targetWorld);
  const wiring = resolveWorkflowWorldWiring(packageName);

  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import * as workflowWorldModule from ${stringifyEsmImportSpecifier(wiring.moduleImportSpecifier)};`,
    ...wiring.extraImportLines,
    ...bootImportLines(),
    "",
    "export const app = await start({",
    "  artifacts: () => resolveNitroCompiledArtifactsSource(artifactsConfig),",
    "  defaultDurable: () =>",
    "    workflowEngine({",
    `      configuredWorld: ${JSON.stringify(input.configuredWorld)},`,
    `      buildDeploymentId: ${JSON.stringify(BUILD_DEPLOYMENT_ID_PLACEHOLDER)},`,
    "      async world() {",
    indent(wiring.createWorldSource),
    "        return workflowWorld;",
    "      },",
    "    }),",
    "});",
    "",
  ].join("\n");
}

export function createDevelopmentWorkflowWorldPluginSource(input: {
  compiledArtifactsBootstrapPath: string;
  configuredWorld: AgentWorkflowWorldDefinition | undefined;
}): string {
  if (!usesParentDevelopmentWorkflowWorld(input.configuredWorld)) {
    return createWorkflowWorldPluginSource({
      ...input,
      defaultWorld: "local",
    });
  }
  const developmentWorldImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/workflow/development-world-client.ts",
  );
  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import { createDevelopmentWorkflowWorld } from ${stringifyEsmImportSpecifier(developmentWorldImportSpecifier)};`,
    ...bootImportLines(),
    "",
    "export const app = await start({",
    "  artifacts: () => resolveNitroCompiledArtifactsSource(artifactsConfig),",
    "  defaultDurable: () => workflowEngine({ world: () => createDevelopmentWorkflowWorld() }),",
    "});",
    "",
  ].join("\n");
}

function createInstrumentationPluginSource(input: {
  agentName: string;
  deferSetup: boolean;
  layout: InstrumentationLayout;
  platformModulePath: string;
}): string {
  const registerProviderPath = resolvePackageSourceFilePath("src/instrumentation/providers.ts");
  const slots = Object.entries(input.layout.modulePathsBySlot);
  const setup = input.deferSetup ? "deferInstrumentationSetup" : "await setUpInstrumentation";

  return [
    "// Generated by eve. Do not edit by hand.",
    ...slots.map(
      ([slot, modulePath], index) =>
        `import * as provider${index} from ${stringifyEsmImportSpecifier(modulePath)}; // ${slot}`,
    ),
    platformImportLine(input.platformModulePath),
    `import { deferInstrumentationSetup, setUpInstrumentation, shutdownInstrumentationProviders } from ${stringifyEsmImportSpecifier(registerProviderPath)};`,
    "",
    `${setup}({`,
    `  agentName: ${JSON.stringify(input.agentName)},`,
    "  platform,",
    "  providers: [",
    ...slots.map(
      ([slot], index) => `    { slot: ${JSON.stringify(slot)}, value: provider${index}.default },`,
    ),
    "  ],",
    "});",
    "",
    "// Default export satisfies the Nitro plugin contract so this file",
    "// can be used directly as a Nitro plugin without a separate wrapper.",
    "export default function installInstrumentationPlugin(nitroApp) {",
    "  // The last point a buffered exporter can still reach the network.",
    "  nitroApp?.hooks?.hook('close', async () => {",
    "    await shutdownInstrumentationProviders();",
    "  });",
    "}",
    "",
  ].join("\n");
}
