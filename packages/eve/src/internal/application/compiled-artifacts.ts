import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CompileMetadata } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageCompiledFilePath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { buildPackageUserAgent } from "#internal/user-agent.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";
import {
  readMaterializedAuthoredModuleIndex,
  type MaterializedInstrumentation,
} from "#internal/materialized-authored-modules.js";
import {
  resolveInstrumentationLayout,
  type InstrumentationLayout,
} from "#internal/instrumentation-layout.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import { resolveWorkflowWorldImport } from "#internal/workflow/world-target.js";

export type BuiltInWorkflowWorldTarget = "local" | "vercel";

export type GeneratedInstrumentationLayout =
  | { readonly kind: "file" }
  | { readonly kind: "directory"; readonly slots: readonly string[] };

type InstrumentationPluginLayout =
  | InstrumentationLayout
  | {
      readonly kind: "module-map";
      readonly moduleMapPath: string;
      readonly sourceId: string;
    };

/**
 * Paths to the generated compiled-artifacts files shared by Nitro and the
 * vendored workflow bundles for one application.
 */
export interface GeneratedCompiledArtifactsFiles {
  /**
   * Shared bundled-artifacts bootstrap installed by Nitro and vendored
   * workflow handlers.
   */
  bootstrapPath: string;
  /** Nitro plugin that installs the selected vendored Workflow world. */
  workflowWorldPluginPath: string;
  /**
   * Optional Nitro plugin that imports the authored instrumentation modules
   * from the application when present.
   */
  instrumentationPluginPath?: string;
  /** Layout identity used by dev plugin selection and structural fingerprinting. */
  instrumentationLayout?: GeneratedInstrumentationLayout;
  /**
   * Absolute paths to the authored instrumentation modules when present — one
   * for the file layout, one per provider in the directory layout. Nitro uses these
   * to preserve each module's side effects during bundling.
   */
  instrumentationSourcePaths?: readonly string[];
}

/**
 * Writes the generated compiled-artifacts bootstrap module.
 *
 * The bootstrap self-installs bundled artifacts on import and exports a
 * default function so it can be used directly as a Nitro plugin — no
 * separate plugin wrapper file is needed.
 */
export async function writeCompiledArtifactsFiles(input: {
  compileResult: CompileAgentResult;
  defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
  outDir: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const instrumentationPluginPath = join(input.outDir, "compiled-artifacts-instrumentation.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const providersEnabled =
    input.compileResult.manifest.config.experimental?.instrumentationProviders ?? false;
  const providerLayout = providersEnabled
    ? resolveInstrumentationLayout({
        agentRoot: input.compileResult.manifest.agentRoot,
        providersEnabled: true,
      })
    : undefined;

  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    bootstrapPath,
    await createCompiledArtifactsBootstrapSource({
      compileResult: input.compileResult,
      installModulePath: resolvePackageSourceFilePath("src/runtime/loaders/bundled-artifacts.ts"),
      moduleMapPath: bootstrapPath,
      metadata: input.compileResult.metadata,
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
    bootstrapPath,
    workflowWorldPluginPath,
  };

  if (input.compileResult.manifest.instrumentation !== undefined) {
    const sourceId = input.compileResult.manifest.instrumentation.sourceId;
    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        layout: { kind: "module-map", moduleMapPath: bootstrapPath, sourceId },
      }),
    );
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationLayout = { kind: "file" };
    const binding = input.compileResult.manifest.bindings[sourceId];
    if (binding?.backing.kind === "filesystem") {
      generatedArtifacts.instrumentationSourcePaths = [binding.backing.sourcePath];
    }
  } else if (providerLayout !== undefined) {
    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        layout: providerLayout,
      }),
    );
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationLayout = generatedInstrumentationLayout(providerLayout);
    generatedArtifacts.instrumentationSourcePaths = instrumentationSourcePathsOf(providerLayout);
  }

  return generatedArtifacts;
}

function instrumentationSourcePathsOf(layout: InstrumentationLayout): readonly string[] {
  return layout.kind === "file" ? [layout.modulePath] : Object.values(layout.modulePathsBySlot);
}

// The dev host's Nitro inputs outlive any single generation, so nothing
// written here may point into authored source or a prunable snapshot: the
// bootstrap references no authored module, and the instrumentation bundle is
// copied out of the generation into the stable host directory.
export async function writeDevelopmentCompiledArtifactsFiles(input: {
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
    bootstrapPath,
    workflowWorldPluginPath,
  };

  if (input.compileResult.manifest.instrumentation !== undefined) {
    const compileRoot = join(input.runtimeAppRoot, ".eve", "compile");
    const moduleMapPath = join(input.outDir, "compiled-artifacts-instrumentation-source.mjs");
    await copyFile(join(compileRoot, materializedIndex.moduleMap), moduleMapPath);
    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        layout: {
          kind: "module-map",
          moduleMapPath,
          sourceId: input.compileResult.manifest.instrumentation.sourceId,
        },
      }),
    );
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationLayout = { kind: "file" };
    generatedArtifacts.instrumentationSourcePaths = [moduleMapPath];
  } else if (materializedIndex.instrumentation !== undefined) {
    const layout = await copyMaterializedInstrumentation({
      instrumentation: materializedIndex.instrumentation,
      outDir: input.outDir,
      runtimeAppRoot: input.runtimeAppRoot,
    });

    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
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
  return layout.kind === "file"
    ? { kind: "file" }
    : { kind: "directory", slots: Object.keys(layout.modulePathsBySlot) };
}

/**
 * Copies each materialized instrumentation bundle out of the prunable
 * generation and into the stable dev-host directory, returning the layout in
 * terms of the copies.
 */
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

  if (input.instrumentation.kind === "file") {
    return {
      kind: "file",
      modulePath: await copyOne("source", input.instrumentation.modulePath),
    };
  }

  const modulePathsBySlot: Record<string, string> = {};
  for (const [slot, modulePath] of Object.entries(input.instrumentation.modulePathsBySlot)) {
    modulePathsBySlot[slot] = await copyOne(slot, modulePath);
  }
  return { kind: "directory", modulePathsBySlot };
}

function createDevelopmentCompiledArtifactsBootstrapSource(agentName: string): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    `import { installEveWorkflowQueueNamespace } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/workflow/queue-namespace.ts"))};`,
    "",
    `installEveWorkflowQueueNamespace(${JSON.stringify(agentName)});`,
    "",
    "export default function installDevelopmentCompiledArtifactsPlugin() {}",
    "",
  ].join("\n");
}

function stripCompiledModuleMapDefaultExport(source: string): string {
  return source.replace(/\nexport default moduleMap;\n?$/, "\n");
}

export async function createCompiledArtifactsBootstrapSource(input: {
  compileResult: CompileAgentResult;
  installModulePath: string;
  metadata: CompileMetadata;
  moduleMapPath: string;
}): Promise<string> {
  const agentName = input.compileResult.manifest.config.name;
  const moduleMapSource = stripCompiledModuleMapDefaultExport(
    createCompiledModuleMapSource({
      importSpecifierStyle: "absolute",
      manifest: input.compileResult.manifest,
      moduleMapPath: input.moduleMapPath,
      programmaticLoaderImportSpecifier: resolvePackageSourceFilePath(
        "src/internal/programmatic-source-loader.ts",
      ),
    }),
  ).trim();

  return [
    "// Generated by eve. Do not edit by hand.",
    `import { installBundledCompiledArtifacts } from ${stringifyEsmImportSpecifier(input.installModulePath)};`,
    `import { installEveWorkflowQueueNamespace } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/workflow/queue-namespace.ts"))};`,
    "",
    `installEveWorkflowQueueNamespace(${JSON.stringify(agentName)});`,
    "",
    moduleMapSource,
    "",
    `const metadata = ${JSON.stringify(input.metadata, null, 2)};`,
    "",
    `const manifest = ${JSON.stringify(input.compileResult.manifest, null, 2)};`,
    "",
    "export function installCompiledArtifactsBootstrap() {",
    "  installBundledCompiledArtifacts({",
    "    manifest,",
    "    metadata,",
    "    moduleMap,",
    "  });",
    "}",
    "",
    "installCompiledArtifactsBootstrap();",
    "",
    "// Default export satisfies the Nitro plugin contract so this file",
    "// can be used directly as a Nitro plugin without a separate wrapper.",
    "export default function installCompiledArtifactsPlugin() {",
    "  // Already installed on import above.",
    "}",
    "",
  ].join("\n");
}

interface WorkflowWorldWiring {
  /** Import specifier for the `workflowWorldModule` namespace import. */
  readonly moduleImportSpecifier: string;
  /** Extra import lines the construction source depends on. */
  readonly extraImportLines: readonly string[];
  /** Named imports pulled from the workflow core runtime. */
  readonly runtimeImports: string;
  /** Statement that assigns `workflowWorld`. */
  readonly createWorldSource: string;
}

/**
 * Per-world wiring for the generated workflow-world plugin. The four pieces
 * co-vary and must stay together: a world constructed through an explicit
 * `createWorld(config)` call must not import `createWorldFromModule`, and
 * only the vendored local World needs the data-directory resolver import.
 */
function resolveWorkflowWorldWiring(packageName: string): WorkflowWorldWiring {
  if (packageName === "@workflow/world-local") {
    const dataDirectoryImportSpecifier = stringifyEsmImportSpecifier(
      resolvePackageSourceFilePath("src/internal/workflow/local-world-data-directory.ts"),
    );
    const moduleImportSpecifier = resolvePackageCompiledFilePath(
      `src/compiled/${packageName}/index.js`,
    );
    const importLines = `
import { resolveLocalWorkflowWorldDataDirectory } from ${dataDirectoryImportSpecifier};`.trimStart();
    const createWorldSource = `
const workflowWorld = await workflowWorldModule.createWorld({
  dataDir: resolveLocalWorkflowWorldDataDirectory(process.cwd()),
});`.trimStart();
    return {
      moduleImportSpecifier,
      extraImportLines: importLines.split("\n"),
      runtimeImports: "getWorld, setWorld",
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
      runtimeImports: "getWorld, setWorld",
      createWorldSource,
    };
  }

  return {
    moduleImportSpecifier: packageName,
    extraImportLines: [],
    runtimeImports: "createWorldFromModule, getWorld, setWorld",
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
  const workflowRuntimeImportSpecifier = resolvePackageCompiledFilePath(
    "src/compiled/@workflow/core/runtime.js",
  );
  const workflowWorldValidationImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/workflow/validate-world.ts",
  );

  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import * as workflowWorldModule from ${stringifyEsmImportSpecifier(wiring.moduleImportSpecifier)};`,
    ...wiring.extraImportLines,
    `import { ${wiring.runtimeImports} } from ${stringifyEsmImportSpecifier(workflowRuntimeImportSpecifier)};`,
    `import { validateWorkflowWorld } from ${stringifyEsmImportSpecifier(workflowWorldValidationImportSpecifier)};`,
    "",
    wiring.createWorldSource,
    `validateWorkflowWorld({ packageName: ${JSON.stringify(input.configuredWorld)}, world: workflowWorld });`,
    "setWorld(workflowWorld);",
    "await getWorld();",
    "await workflowWorld.start?.();",
    "",
    "export default function installWorkflowWorldPlugin() {}",
    "",
  ].join("\n");
}

/**
 * Generates the dev worker's Workflow World wiring. Configs that resolve to
 * the vendored local World get the parent RPC client so run state survives
 * worker replacement; any other World is instantiated inside the worker
 * unchanged, because eve does not own its lifetime. The selection predicate
 * is shared with the parent's world creation — a worker wired for the RPC
 * client fails every World call unless the parent created a World to serve
 * it.
 */
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
  const workflowRuntimeImportSpecifier = resolvePackageCompiledFilePath(
    "src/compiled/@workflow/core/runtime.js",
  );
  const developmentWorldImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/workflow/development-world-client.ts",
  );
  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import { getWorld, setWorld } from ${stringifyEsmImportSpecifier(workflowRuntimeImportSpecifier)};`,
    `import { createDevelopmentWorkflowWorld } from ${stringifyEsmImportSpecifier(developmentWorldImportSpecifier)};`,
    "",
    "setWorld(createDevelopmentWorkflowWorld());",
    "await getWorld();",
    "",
    "export default function installDevelopmentWorkflowWorldPlugin() {}",
    "",
  ].join("\n");
}

/**
 * Generates the Nitro plugin that registers the authored instrumentation.
 *
 * The file layout registers one default export; the directory layout
 * registers one per file, in slot order, awaiting each `setup` so a provider
 * cannot miss an event published while it is still starting up, then builds the
 * one OpenTelemetry pipeline their declarations add up to.
 */
function createInstrumentationPluginSource(input: {
  agentName: string;
  layout: InstrumentationPluginLayout;
}): string {
  const agentName = JSON.stringify(input.agentName);

  if (input.layout.kind === "module-map") {
    const registerConfigPath = resolvePackageSourceFilePath(
      "src/harness/instrumentation/config.ts",
    );
    return [
      "// Generated by eve. Do not edit by hand.",
      `import { moduleMap } from ${stringifyEsmImportSpecifier(input.layout.moduleMapPath)};`,
      `import { registerInstrumentationConfig } from ${stringifyEsmImportSpecifier(registerConfigPath)};`,
      "",
      `const instrumentationModule = moduleMap.nodes["__root__"].modules[${JSON.stringify(input.layout.sourceId)}];`,
      "if (instrumentationModule.default != null) {",
      `  await registerInstrumentationConfig(instrumentationModule.default, { agentName: ${agentName} });`,
      "}",
      "",
      "export default function installInstrumentationPlugin() {}",
      "",
    ].join("\n");
  }

  if (input.layout.kind === "file") {
    const registerConfigPath = resolvePackageSourceFilePath(
      "src/harness/instrumentation/config.ts",
    );
    return [
      "// Generated by eve. Do not edit by hand.",
      `import * as instrumentationModule from ${stringifyEsmImportSpecifier(input.layout.modulePath)};`,
      `import { registerInstrumentationConfig } from ${stringifyEsmImportSpecifier(registerConfigPath)};`,
      "",
      "if (instrumentationModule.default != null) {",
      `  await registerInstrumentationConfig(instrumentationModule.default, { agentName: ${agentName} });`,
      "}",
      "",
      "// Default export satisfies the Nitro plugin contract so this file",
      "// can be used directly as a Nitro plugin without a separate wrapper.",
      "export default function installInstrumentationPlugin() {}",
      "",
    ].join("\n");
  }

  const registerProviderPath = resolvePackageSourceFilePath("src/instrumentation/providers.ts");
  const slots = Object.entries(input.layout.modulePathsBySlot);

  return [
    "// Generated by eve. Do not edit by hand.",
    ...slots.map(
      ([slot, modulePath], index) =>
        `import * as provider${index} from ${stringifyEsmImportSpecifier(modulePath)}; // ${slot}`,
    ),
    `import { finalizeInstrumentationProviders, registerInstrumentationProvider, seedInstrumentationProviders, shutdownInstrumentationProviders } from ${stringifyEsmImportSpecifier(registerProviderPath)};`,
    "",
    "seedInstrumentationProviders();",
    "",
    ...slots.flatMap(([slot], index) => [
      "await registerInstrumentationProvider({",
      `  agentName: ${agentName},`,
      `  slot: ${JSON.stringify(slot)},`,
      `  value: provider${index}.default,`,
      "});",
    ]),
    "",
    `finalizeInstrumentationProviders({ serviceName: ${agentName} });`,
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
