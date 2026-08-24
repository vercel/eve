import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CompileMetadata } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import { compiledInstrumentationPlanActivatesInMode } from "#compiler/instrumentation-plan-activation.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createCompiledModuleMapDescriptorSource,
  createCompiledModuleMapIdentity,
} from "#compiler/module-map.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageCompiledFilePath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { buildPackageUserAgent } from "#internal/user-agent.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";
import {
  assertCompilerDiagnosticsArtifactSemantics,
  compilerDiagnosticsArtifactSchema,
} from "#protocol/compiler-diagnostics-artifact.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";
import { loadCompiledArtifactEnvelope } from "#runtime/loaders/compiled-artifact-set.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import { resolveBuiltInWorkflowWorldPackage } from "#internal/workflow/world-target.js";

export type { BuiltInWorkflowWorldTarget } from "#internal/workflow/world-target.js";

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
   * Nitro plugin generated only when the instrumentation plan has an active
   * entry for the host mode.
   */
  instrumentationPluginPath?: string;
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
  outDir: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const instrumentationPluginPath = compiledInstrumentationPlanActivatesInMode(
    input.compileResult.manifest.instrumentation,
    "production",
  )
    ? join(input.outDir, "compiled-artifacts-instrumentation.mjs")
    : undefined;
  const worldPlan = input.compileResult.manifest.workflowWorld;

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
      worldPlan,
    }),
  );
  if (instrumentationPluginPath !== undefined) {
    await writeFile(
      instrumentationPluginPath,
      createProductionInstrumentationPluginSource({
        compiledArtifactsBootstrapPath: bootstrapPath,
      }),
    );
  }

  const generatedArtifacts: GeneratedCompiledArtifactsFiles = {
    bootstrapPath,
    workflowWorldPluginPath,
  };
  if (instrumentationPluginPath !== undefined) {
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
  }

  return generatedArtifacts;
}

// The dev host's Nitro inputs outlive any single generation, so nothing
// written here may point into authored source or a prunable snapshot: the
// bootstrap references no authored module, while instrumentation is copied out
// of the generation into the stable host directory.
export async function writeDevelopmentCompiledArtifactsFiles(input: {
  readonly compileResult: CompileAgentResult;
  readonly outDir: string;
  readonly runtimeAppRoot: string;
}): Promise<GeneratedCompiledArtifactsFiles> {
  const bootstrapPath = join(input.outDir, "compiled-artifacts-bootstrap.mjs");
  const workflowWorldPluginPath = join(input.outDir, "compiled-artifacts-workflow-world.mjs");
  const instrumentationPluginPath = compiledInstrumentationPlanActivatesInMode(
    input.compileResult.manifest.instrumentation,
    "development",
  )
    ? join(input.outDir, "compiled-artifacts-instrumentation.mjs")
    : undefined;
  const worldPlan = input.compileResult.manifest.workflowWorld;

  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    bootstrapPath,
    createDevelopmentCompiledArtifactsBootstrapSource(input.compileResult.manifest.config.name),
  );
  await writeFile(
    workflowWorldPluginPath,
    createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: bootstrapPath,
      worldPlan,
    }),
  );
  if (instrumentationPluginPath !== undefined) {
    const envelope = await loadCompiledArtifactEnvelope({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(input.runtimeAppRoot),
    });
    const materializedIndex = await readMaterializedAuthoredModuleIndex({
      metadata: envelope.metadata,
      runtimeAppRoot: input.runtimeAppRoot,
    });
    if (materializedIndex === undefined) {
      throw new Error(`Development generation at "${input.runtimeAppRoot}" is not materialized.`);
    }
    const descriptorSha256 = createHash("sha256")
      .update(materializedIndex.moduleMapCode)
      .digest("hex");
    const descriptorPath = join(
      input.outDir,
      `compiled-artifacts-module-map-${descriptorSha256}.mjs`,
    );
    await writeFile(descriptorPath, materializedIndex.moduleMapCode);
    await writeFile(
      instrumentationPluginPath,
      createDevelopmentInstrumentationPluginSource({
        descriptorPath,
        descriptorSha256,
        diagnostics: envelope.diagnostics,
        manifest: envelope.manifest,
        metadata: envelope.metadata,
      }),
    );
  }

  const generatedArtifacts: GeneratedCompiledArtifactsFiles = {
    bootstrapPath,
    workflowWorldPluginPath,
  };
  if (instrumentationPluginPath !== undefined) {
    generatedArtifacts.instrumentationPluginPath = instrumentationPluginPath;
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

export async function createCompiledArtifactsBootstrapSource(input: {
  compileResult: CompileAgentResult;
  installModulePath: string;
  metadata: CompileMetadata;
  moduleMapPath: string;
}): Promise<string> {
  const [manifestSource, diagnosticsSource] = await Promise.all([
    readFile(input.compileResult.paths.compiledManifestPath, "utf8"),
    readFile(input.compileResult.paths.diagnosticsPath, "utf8"),
  ]);
  const manifest = parseCompiledAgentManifest(JSON.parse(manifestSource) as unknown);
  const diagnostics = compilerDiagnosticsArtifactSchema.parse(
    JSON.parse(diagnosticsSource) as unknown,
  );
  const agentName = manifest.config.name;
  assertCompilerDiagnosticsArtifactSemantics({
    artifact: diagnostics,
    manifest,
  });
  const moduleMapIdentity = await createCompiledModuleMapIdentity(manifest);
  if (moduleMapIdentity !== input.metadata.compile.moduleMap.identitySha256) {
    throw new Error(
      "Cannot generate a bundled compiled-artifacts bootstrap because selected module source content changed after compilation.",
    );
  }
  const moduleMapDescriptorSource = createCompiledModuleMapDescriptorSource({
    identity: moduleMapIdentity,
    importSpecifierStyle: "absolute",
    manifest,
    moduleMapPath: input.moduleMapPath,
  });

  return [
    "// Generated by eve. Do not edit by hand.",
    `import { installBundledCompiledArtifactsFromDescriptor } from ${stringifyEsmImportSpecifier(input.installModulePath)};`,
    `import { installEveWorkflowQueueNamespace } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/workflow/queue-namespace.ts"))};`,
    "",
    `const diagnostics = ${JSON.stringify(diagnostics, null, 2)};`,
    "",
    `const metadata = ${JSON.stringify(input.metadata, null, 2)};`,
    "",
    `const manifest = ${JSON.stringify(manifest, null, 2)};`,
    "",
    `const moduleMapDescriptor = ${moduleMapDescriptorSource};`,
    "",
    "export async function installCompiledArtifactsBootstrap() {",
    "  await installBundledCompiledArtifactsFromDescriptor({",
    "    diagnostics,",
    "    manifest,",
    "    metadata,",
    "    moduleMapDescriptor,",
    "  });",
    `  installEveWorkflowQueueNamespace(${JSON.stringify(agentName)});`,
    "}",
    "",
    "await installCompiledArtifactsBootstrap();",
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
function resolveWorkflowWorldWiring(input: {
  readonly worldPlan: CompiledWorkflowWorldPlan;
}): WorkflowWorldWiring {
  const packageName =
    input.worldPlan.kind === "host-module"
      ? input.worldPlan.packageName
      : resolveBuiltInWorkflowWorldPackage(input.worldPlan.target);
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
    moduleImportSpecifier:
      input.worldPlan.kind === "host-module" ? input.worldPlan.backing.entryPath : packageName,
    extraImportLines: [],
    runtimeImports: "createWorldFromModule, getWorld, setWorld",
    createWorldSource: "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
  };
}

export function createWorkflowWorldPluginSource(input: {
  compiledArtifactsBootstrapPath: string;
  worldPlan: CompiledWorkflowWorldPlan;
}): string {
  const wiring = resolveWorkflowWorldWiring(input);
  const workflowRuntimeImportSpecifier = resolvePackageCompiledFilePath(
    "src/compiled/@workflow/core/runtime.js",
  );
  const workflowWorldValidationImportSpecifier = resolvePackageSourceFilePath(
    "src/internal/workflow/validate-world.ts",
  );

  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    ...wiring.extraImportLines,
    `import { ${wiring.runtimeImports} } from ${stringifyEsmImportSpecifier(workflowRuntimeImportSpecifier)};`,
    `import { validateWorkflowWorld } from ${stringifyEsmImportSpecifier(workflowWorldValidationImportSpecifier)};`,
    "",
    `const workflowWorldModule = await import(${stringifyEsmImportSpecifier(wiring.moduleImportSpecifier)});`,
    wiring.createWorldSource,
    "validateWorkflowWorld({ world: workflowWorld });",
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
  worldPlan: CompiledWorkflowWorldPlan;
}): string {
  if (!usesParentDevelopmentWorkflowWorld(input.worldPlan)) {
    return createWorkflowWorldPluginSource({
      ...input,
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

function createProductionInstrumentationPluginSource(input: {
  readonly compiledArtifactsBootstrapPath: string;
}): string {
  const bundledArtifactsPath = resolvePackageSourceFilePath(
    "src/runtime/loaders/bundled-artifacts.ts",
  );
  const runtimePath = resolvePackageSourceFilePath("src/internal/instrumentation-plan-runtime.ts");
  return [
    "// Generated by eve. Do not edit by hand.",
    `import ${stringifyEsmImportSpecifier(input.compiledArtifactsBootstrapPath)};`,
    `import { readBundledCompiledArtifacts } from ${stringifyEsmImportSpecifier(bundledArtifactsPath)};`,
    `import { installCompiledInstrumentationPlan } from ${stringifyEsmImportSpecifier(runtimePath)};`,
    "",
    "const artifacts = readBundledCompiledArtifacts();",
    "if (artifacts === null) throw new Error('Bundled compiled artifacts must be installed before instrumentation.');",
    "const shutdown = await installCompiledInstrumentationPlan({",
    "  appRoot: artifacts.manifest.appRoot,",
    "  async loadModule(sourceId) {",
    "    const namespace = artifacts.moduleMap.nodes.__root__?.modules[sourceId];",
    '    if (namespace === undefined) throw new Error(`Compiled instrumentation source "${sourceId}" is missing from the module map.`);',
    "    return namespace;",
    "  },",
    "  mode: 'production',",
    "  plan: artifacts.manifest.instrumentation,",
    "  serviceName: artifacts.manifest.config.name,",
    "});",
    "",
    "export default function installInstrumentationPlugin(nitroApp) {",
    "  nitroApp?.hooks?.hook('close', shutdown);",
    "}",
    "",
  ].join("\n");
}

function createDevelopmentInstrumentationPluginSource(input: {
  readonly descriptorPath: string;
  readonly descriptorSha256: string;
  readonly diagnostics: unknown;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
}): string {
  const capturedDescriptorPath = resolvePackageSourceFilePath(
    "src/runtime/loaders/captured-module-map-descriptor.ts",
  );
  const runtimePath = resolvePackageSourceFilePath("src/internal/instrumentation-plan-runtime.ts");
  return [
    "// Generated by eve. Do not edit by hand.",
    `import { withAuthenticatedCompiledModuleMapDescriptor } from ${stringifyEsmImportSpecifier(capturedDescriptorPath)};`,
    `import { installCompiledInstrumentationPlan } from ${stringifyEsmImportSpecifier(runtimePath)};`,
    "",
    "const shutdown = await withAuthenticatedCompiledModuleMapDescriptor({",
    `  descriptorPath: ${JSON.stringify(input.descriptorPath)},`,
    `  descriptorSha256: ${JSON.stringify(input.descriptorSha256)},`,
    `  diagnostics: ${JSON.stringify(input.diagnostics, null, 2)},`,
    `  manifest: ${JSON.stringify(input.manifest, null, 2)},`,
    `  metadata: ${JSON.stringify(input.metadata, null, 2)},`,
    `  runtimeAppRoot: ${JSON.stringify(input.manifest.appRoot)},`,
    "  async run(descriptor) {",
    "    return await installCompiledInstrumentationPlan({",
    `      appRoot: ${JSON.stringify(input.manifest.appRoot)},`,
    "      async loadModule(sourceId) {",
    "        const loader = descriptor.nodes.__root__?.modules[sourceId];",
    '        if (loader === undefined) throw new Error(`Compiled instrumentation source "${sourceId}" is missing from the module-map descriptor.`);',
    "        return await loader.load();",
    "      },",
    "      mode: 'development',",
    `      plan: ${JSON.stringify(input.manifest.instrumentation, null, 2)},`,
    `      serviceName: ${JSON.stringify(input.manifest.config.name)},`,
    "    });",
    "  },",
    "});",
    "",
    "export default function installInstrumentationPlugin(nitroApp) {",
    "  nitroApp?.hooks?.hook('close', shutdown);",
    "}",
    "",
  ].join("\n");
}
