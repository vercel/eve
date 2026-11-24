import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

export interface GeneratedInstrumentationLayout {
  readonly kind: "directory";
  readonly slots: readonly string[];
}

export interface GeneratedCompiledArtifactsFiles {
  readonly authoredWorkflowModules?: AuthoredWorkflowModules;
  bootstrapPath: string;
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
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
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
  await writeFile(processPath, createProcessSource(dataPath));
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
  readonly runtimeAppRoot: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const instrumentationPluginPath = join(input.outDir, "compiled-artifacts-instrumentation.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const materializedIndex = await readMaterializedAuthoredModuleIndex(input.runtimeAppRoot);

  if (materializedIndex === undefined) {
    throw new Error(`Development generation at "${input.runtimeAppRoot}" is not materialized.`);
  }

  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    bootstrapPath,
    createDevelopmentCompiledArtifactsBootstrapSource(input.compileResult.manifest.config.name),
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

function createDevelopmentCompiledArtifactsBootstrapSource(agentName: string): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    bootProcessImportLine(),
    platformImportLine(),
    "",
    `bootProcess({ agentName: ${JSON.stringify(agentName)}, platform: builtInPlatform }, "artifacts");`,
    "",
  ].join("\n");
}

function bootProcessImportLine(): string {
  return `import { bootProcess } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/runtime/lifecycle.ts"))};`;
}

function platformImportLine(): string {
  return `import { builtInPlatform } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/platform/builtin.ts"))};`;
}

function createProcessSource(dataPath: string): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    bootProcessImportLine(),
    platformImportLine(),
    `import data from ${stringifyNitroDataImportSpecifier("text", dataPath)};`,
    "",
    "export const artifacts = JSON.parse(data);",
    "bootProcess(",
    "  { agentName: artifacts.manifest.config.name, platform: builtInPlatform },",
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
    "bootProcess(",
    "  { agentName: artifacts.manifest.config.name, artifacts: { ...artifacts, moduleMap } },",
    '  "artifacts",',
    ");",
    "",
  ].join("\n");
}

function bootImportLines(): string[] {
  return [
    `import { start } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/runtime/start.ts"))};`,
    `import { workflowEngine } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/execution/workflow-host/engine.ts"))};`,
  ];
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => (line === "" ? line : `      ${line}`))
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
    "  durable: workflowEngine({",
    `    configuredWorld: ${JSON.stringify(input.configuredWorld)},`,
    `    buildDeploymentId: ${JSON.stringify(BUILD_DEPLOYMENT_ID_PLACEHOLDER)},`,
    "    async world() {",
    indent(wiring.createWorldSource),
    "      return workflowWorld;",
    "    },",
    "  }),",
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
    "  durable: workflowEngine({ world: () => createDevelopmentWorkflowWorld() }),",
    "});",
    "",
  ].join("\n");
}

function createInstrumentationPluginSource(input: {
  agentName: string;
  deferSetup: boolean;
  layout: InstrumentationLayout;
}): string {
  const agentName = JSON.stringify(input.agentName);

  const registerProviderPath = resolvePackageSourceFilePath("src/instrumentation/providers.ts");
  const slots = Object.entries(input.layout.modulePathsBySlot);
  const registrations = slots.map(
    ([slot], index) =>
      `registerInstrumentationProvider({ agentName: ${agentName}, slot: ${JSON.stringify(slot)}, value: provider${index}.default })`,
  );

  return [
    "// Generated by eve. Do not edit by hand.",
    ...slots.map(
      ([slot, modulePath], index) =>
        `import * as provider${index} from ${stringifyEsmImportSpecifier(modulePath)}; // ${slot}`,
    ),
    `import { deferInstrumentationSetup, finalizeInstrumentationProviders, registerInstrumentationProvider, seedInstrumentationProviders, shutdownInstrumentationProviders } from ${stringifyEsmImportSpecifier(registerProviderPath)};`,
    "",
    "seedInstrumentationProviders();",
    "",
    ...(input.deferSetup
      ? [
          "deferInstrumentationSetup({",
          `  serviceName: ${agentName},`,
          "  setups: [",
          ...registrations.map((registration) => `    ${registration},`),
          "  ],",
          "});",
        ]
      : [
          ...registrations.map((registration) => `await ${registration};`),
          "",
          `finalizeInstrumentationProviders({ serviceName: ${agentName} });`,
        ]),
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
