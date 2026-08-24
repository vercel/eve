import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  type CompilerDiagnostic,
  type CompilerDiagnosticsSummary,
} from "#shared/compiler-diagnostics.js";
import {
  assertCompilerDiagnosticsArtifactSemantics,
  createCompilerDiagnosticsArtifact,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#protocol/compile-metadata.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createCompiledModuleMapDescriptorModuleSource,
  createCompiledModuleMapIdentity,
} from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { materializeWorkspaceResources } from "#compiler/workspace-resources.js";
import { materializeCompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan-materialization.js";
import type { BuiltInWorkflowWorldTarget } from "#internal/workflow/world-target.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";

export {
  COMPILER_DIAGNOSTICS_ARTIFACT_KIND,
  COMPILER_DIAGNOSTICS_ARTIFACT_VERSION,
  compilerDiagnosticsArtifactSchema,
  createCompilerDiagnosticsArtifact,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
export {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#protocol/compile-metadata.js";

/**
 * Structured paths for compiler-owned artifacts under `.eve/`.
 */
export interface CompilerArtifactPaths {
  appRoot: string;
  compiledManifestPath: string;
  compileDirectoryPath: string;
  compileMetadataPath: string;
  diagnosticsPath: string;
  discoveryManifestPath: string;
  discoveryDirectoryPath: string;
  moduleMapPath: string;
}

export interface CompilerArtifactLocations {
  readonly publishedRoot: string;
  readonly writeRoot: string;
}

/**
 * Input for writing compiler-owned discovery artifacts.
 */
interface WriteCompilerArtifactsInput {
  appRoot: string;
  artifactLocations: CompilerArtifactLocations;
  defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
  diagnostics: readonly CompilerDiagnostic[];
  manifest: AgentSourceManifest;
}

/**
 * Result of writing compiler-owned artifacts.
 */
interface WriteCompilerArtifactsResult {
  compiledManifest: CompiledAgentManifest;
  diagnosticsArtifact: CompilerDiagnosticsArtifact;
  metadata: CompileMetadata;
  moduleMapSource: string;
  paths: CompilerArtifactPaths;
}

/** Resolves stable compiler-owned artifact paths for one application root. */
export function resolveCompilerArtifactPaths(appRoot: string): CompilerArtifactPaths {
  return resolveCompilerArtifactPathsAt(appRoot, join(resolve(appRoot), ".eve"));
}

function resolveCompilerArtifactPathsAt(
  appRoot: string,
  artifactsRoot: string,
): CompilerArtifactPaths {
  const resolvedAppRoot = resolve(appRoot);
  const resolvedArtifactsRoot = resolve(artifactsRoot);
  const discoveryDirectoryPath = join(resolvedArtifactsRoot, "discovery");
  const compileDirectoryPath = join(resolvedArtifactsRoot, "compile");

  return {
    appRoot: resolvedAppRoot,
    compiledManifestPath: join(compileDirectoryPath, "compiled-agent-manifest.json"),
    compileDirectoryPath,
    compileMetadataPath: join(compileDirectoryPath, "compile-metadata.json"),
    diagnosticsPath: join(discoveryDirectoryPath, "diagnostics.json"),
    discoveryManifestPath: join(discoveryDirectoryPath, "agent-discovery-manifest.json"),
    discoveryDirectoryPath,
    moduleMapPath: join(compileDirectoryPath, "module-map.mjs"),
  };
}

/**
 * Creates deterministic compile metadata from already-serialized artifact
 * payloads.
 */
export function createCompileMetadata(input: {
  appRoot: string;
  compiledManifestJson: string;
  diagnosticsArtifactJson: string;
  diagnosticsSummary: CompilerDiagnosticsSummary;
  discoveryManifestJson: string;
  moduleMapIdentity: string;
  moduleMapSource: string;
  paths: CompilerArtifactPaths;
}): CompileMetadata {
  const generator = resolveInstalledPackageInfo();
  const manifestHash = createContentHash(input.discoveryManifestJson);
  const compiledManifestHash = createContentHash(input.compiledManifestJson);
  const diagnosticsHash = createContentHash(input.diagnosticsArtifactJson);
  const moduleMapHash = createContentHash(input.moduleMapSource);

  return {
    compile: {
      manifest: {
        path: toArtifactRelativePath(input.appRoot, input.paths.compiledManifestPath),
        sha256: compiledManifestHash,
      },
      moduleMap: {
        identitySha256: input.moduleMapIdentity,
        path: toArtifactRelativePath(input.appRoot, input.paths.moduleMapPath),
        sha256: moduleMapHash,
      },
    },
    discovery: {
      diagnostics: {
        path: toArtifactRelativePath(input.appRoot, input.paths.diagnosticsPath),
        sha256: diagnosticsHash,
      },
      manifest: {
        path: toArtifactRelativePath(input.appRoot, input.paths.discoveryManifestPath),
        sha256: manifestHash,
      },
      sourceGraphHash: createContentHash(
        `${manifestHash}:${compiledManifestHash}:${diagnosticsHash}:${moduleMapHash}:${input.moduleMapIdentity}`,
      ),
      summary: input.diagnosticsSummary,
    },
    generator: {
      name: generator.name,
      version: generator.version,
    },
    kind: COMPILE_METADATA_KIND,
    status: input.diagnosticsSummary.errors > 0 ? "failed" : "ready",
    version: COMPILE_METADATA_VERSION,
  };
}

/** Writes compiler-owned artifacts and records their stable published locations. */
export async function writeCompilerArtifacts(
  input: WriteCompilerArtifactsInput,
): Promise<WriteCompilerArtifactsResult> {
  const paths = resolveCompilerArtifactPathsAt(input.appRoot, input.artifactLocations.writeRoot);
  const publishedPaths = resolveCompilerArtifactPathsAt(
    input.appRoot,
    input.artifactLocations.publishedRoot,
  );
  const diagnostics = [...input.diagnostics];
  const workspaceManifest = await materializeWorkspaceResources({
    compileDirectoryPath: paths.compileDirectoryPath,
    manifest: await compileAgentManifest(input.manifest, {
      defaultWorkflowWorld: input.defaultWorkflowWorld,
      diagnostics,
    }),
  });
  const compiledManifest = parseCompiledAgentManifest({
    ...workspaceManifest,
    workflowWorld: await materializeCompiledWorkflowWorldPlan({
      destinationRoot: join(paths.compileDirectoryPath, "workflow-world"),
      plan: workspaceManifest.workflowWorld,
    }),
  });
  const diagnosticsArtifact = createCompilerDiagnosticsArtifact(diagnostics);
  assertCompilerDiagnosticsArtifactSemantics({
    artifact: diagnosticsArtifact,
    manifest: compiledManifest,
  });
  const compiledManifestJson = serializeArtifactJson(compiledManifest);
  const discoveryManifestJson = serializeArtifactJson(input.manifest);
  const diagnosticsArtifactJson = serializeArtifactJson(diagnosticsArtifact);
  const moduleMapIdentity = await createCompiledModuleMapIdentity(compiledManifest);
  const moduleMapSource = createCompiledModuleMapDescriptorModuleSource({
    identity: moduleMapIdentity,
    manifest: compiledManifest,
    moduleMapPath: publishedPaths.moduleMapPath,
  });
  const metadata = createCompileMetadata({
    appRoot: input.appRoot,
    compiledManifestJson,
    diagnosticsArtifactJson,
    diagnosticsSummary: diagnosticsArtifact.summary,
    discoveryManifestJson,
    moduleMapIdentity,
    moduleMapSource,
    paths: publishedPaths,
  });
  const metadataJson = serializeArtifactJson(metadata);

  await mkdir(paths.discoveryDirectoryPath, {
    recursive: true,
  });
  await mkdir(paths.compileDirectoryPath, {
    recursive: true,
  });
  await publishCompilerArtifactFiles({
    metadataJson,
    paths,
    payloads: {
      compiledManifestJson,
      diagnosticsArtifactJson,
      discoveryManifestJson,
      moduleMapSource,
    },
  });

  return {
    compiledManifest,
    diagnosticsArtifact,
    metadata,
    moduleMapSource,
    paths,
  };
}

export interface CompilerArtifactFileIo {
  readonly remove: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly write: (path: string, contents: string) => Promise<void>;
}

/** Stages every payload before briefly replacing the metadata-committed snapshot. */
export async function publishCompilerArtifactFiles(input: {
  readonly io?: CompilerArtifactFileIo;
  readonly metadataJson: string;
  readonly paths: CompilerArtifactPaths;
  readonly payloads: {
    readonly compiledManifestJson: string;
    readonly diagnosticsArtifactJson: string;
    readonly discoveryManifestJson: string;
    readonly moduleMapSource: string;
  };
}): Promise<void> {
  const io: CompilerArtifactFileIo = input.io ?? {
    remove: async (path) => await rm(path, { force: true }),
    rename,
    write: async (path, contents) => await writeFile(path, contents),
  };

  const transactionId = `${process.pid}.${randomUUID()}`;
  const stagedPayloads = [
    {
      contents: input.payloads.compiledManifestJson,
      finalPath: input.paths.compiledManifestPath,
    },
    { contents: input.payloads.diagnosticsArtifactJson, finalPath: input.paths.diagnosticsPath },
    {
      contents: input.payloads.discoveryManifestJson,
      finalPath: input.paths.discoveryManifestPath,
    },
    { contents: input.payloads.moduleMapSource, finalPath: input.paths.moduleMapPath },
  ].map((payload) => ({
    ...payload,
    temporaryPath: `${payload.finalPath}.${transactionId}.tmp`,
  }));

  try {
    const writes = await Promise.allSettled(
      stagedPayloads.map((payload) => io.write(payload.temporaryPath, payload.contents)),
    );
    const failedWrite = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWrite !== undefined) throw failedWrite.reason;

    // The previous marker remains readable throughout expensive payload
    // generation. Its absence covers only the short final rename window.
    await io.remove(input.paths.compileMetadataPath);
    await Promise.all(
      stagedPayloads.map((payload) => io.rename(payload.temporaryPath, payload.finalPath)),
    );
    await publishCompileMetadataCommitMarker({
      contents: input.metadataJson,
      io,
      path: input.paths.compileMetadataPath,
    });
  } finally {
    await Promise.all(stagedPayloads.map((payload) => io.remove(payload.temporaryPath)));
  }
}

/** Atomically exposes a complete metadata marker after its contents are durable. */
export async function publishCompileMetadataCommitMarker(input: {
  readonly contents: string;
  readonly io?: CompilerArtifactFileIo;
  readonly path: string;
}): Promise<void> {
  const io: CompilerArtifactFileIo = input.io ?? {
    remove: async (path) => await rm(path, { force: true }),
    rename,
    write: async (path, contents) => await writeFile(path, contents),
  };
  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.write(temporaryPath, input.contents);
    await io.rename(temporaryPath, input.path);
  } finally {
    await io.remove(temporaryPath);
  }
}

function createContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toArtifactRelativePath(appRoot: string, targetPath: string): string {
  return normalizeLogicalPath(relative(resolve(appRoot), targetPath));
}
