import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CompileMetadata } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { getWorldImport } from "@workflow/utils";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageCompiledFilePath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";

export type BuiltInWorkflowWorldTarget = "local" | "vercel";

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
   * Optional Nitro plugin that imports the authored instrumentation module
   * from the application when present.
   */
  instrumentationPluginPath?: string;
  /**
   * Absolute path to the authored instrumentation module when present.
   * Nitro uses this to preserve the module's side effects during bundling.
   */
  instrumentationSourcePath?: string;
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
  const instrumentationPath = resolveInstrumentationModule(input.compileResult.manifest.agentRoot);

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

  if (instrumentationPath !== undefined) {
    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        instrumentationPath,
        registerConfigPath: resolvePackageSourceFilePath("src/harness/instrumentation-config.ts"),
      }),
    );
  }

  const generatedArtifacts: GeneratedCompiledArtifactsFiles = {
    bootstrapPath,
    workflowWorldPluginPath,
  };

  if (instrumentationPath !== undefined) {
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationSourcePath = instrumentationPath;
  }

  return generatedArtifacts;
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
  const instrumentationSourcePath = join(
    input.outDir,
    "compiled-artifacts-instrumentation-source.mjs",
  );
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

  if (materializedIndex.instrumentation !== undefined) {
    await copyFile(
      join(input.runtimeAppRoot, ".eve", "compile", materializedIndex.instrumentation),
      instrumentationSourcePath,
    );
    await writeFile(
      instrumentationPluginPath,
      createInstrumentationPluginSource({
        agentName: input.compileResult.manifest.config.name,
        instrumentationPath: instrumentationSourcePath,
        registerConfigPath: resolvePackageSourceFilePath("src/harness/instrumentation-config.ts"),
      }),
    );
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
    generatedArtifacts.instrumentationSourcePath = instrumentationSourcePath;
  }

  return generatedArtifacts;
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

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

/**
 * Resolves the optional `agent/instrumentation` module from the agent root
 * directory. Returns the absolute path if found, `undefined` otherwise.
 */
function resolveInstrumentationModule(agentRoot: string): string | undefined {
  for (const ext of INSTRUMENTATION_EXTENSIONS) {
    const candidate = join(agentRoot, `instrumentation${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function stripCompiledModuleMapExports(source: string): string {
  return source
    .replace(/^export const moduleMap = /m, "const moduleMap = ")
    .replace(/\nexport default moduleMap;\n?$/, "\n");
}

export async function createCompiledArtifactsBootstrapSource(input: {
  compileResult: CompileAgentResult;
  installModulePath: string;
  metadata: CompileMetadata;
  moduleMapPath: string;
}): Promise<string> {
  const agentName = input.compileResult.manifest.config.name;
  const moduleMapSource = stripCompiledModuleMapExports(
    createCompiledModuleMapSource({
      importSpecifierStyle: "absolute",
      manifest: input.compileResult.manifest,
      moduleMapPath: input.moduleMapPath,
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

export function createWorkflowWorldPluginSource(input: {
  compiledArtifactsBootstrapPath: string;
  configuredWorld: AgentWorkflowWorldDefinition | undefined;
  defaultWorld: BuiltInWorkflowWorldTarget;
}): string {
  const targetWorld = input.configuredWorld ?? input.defaultWorld;
  const packageName = getWorldImport({ WORKFLOW_TARGET_WORLD: targetWorld });
  const importSpecifier =
    packageName === "@workflow/world-local" || packageName === "@workflow/world-vercel"
      ? resolvePackageCompiledFilePath(`src/compiled/${packageName}/index.js`)
      : packageName;
  const workflowRuntimeImportSpecifier = resolvePackageCompiledFilePath(
    "src/compiled/@workflow/core/runtime.js",
  );
  const workflowWorldValidationImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/workflow/validate-world.ts",
  );

  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import * as workflowWorldModule from ${stringifyEsmImportSpecifier(importSpecifier)};`,
    `import { createWorldFromModule, getWorld, setWorld } from ${stringifyEsmImportSpecifier(workflowRuntimeImportSpecifier)};`,
    `import { validateWorkflowWorld } from ${stringifyEsmImportSpecifier(workflowWorldValidationImportSpecifier)};`,
    "",
    "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
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

function createInstrumentationPluginSource(input: {
  agentName: string;
  instrumentationPath: string;
  registerConfigPath: string;
}): string {
  return [
    "// Generated by eve. Do not edit by hand.",
    `import * as instrumentationModule from ${stringifyEsmImportSpecifier(input.instrumentationPath)};`,
    `import { registerInstrumentationConfig } from ${stringifyEsmImportSpecifier(input.registerConfigPath)};`,
    "",
    "if (instrumentationModule.default != null) {",
    `  registerInstrumentationConfig(instrumentationModule.default, { agentName: ${JSON.stringify(input.agentName)} });`,
    "}",
    "",
    "// Default export satisfies the Nitro plugin contract so this file",
    "// can be used directly as a Nitro plugin without a separate wrapper.",
    "export default function installInstrumentationPlugin() {}",
    "",
  ].join("\n");
}
