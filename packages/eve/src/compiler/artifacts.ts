import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { z } from "#compiled/zod/index.js";
import {
  discoverDiagnosticsSummarySchema,
  type DiscoverDiagnostic,
  type DiscoverDiagnosticsSummary,
} from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  compilerDiagnosticSchema,
  projectDiscoverDiagnostic,
  summarizeCompilerDiagnostics,
  type CompilerDiagnostic,
} from "#compiler/diagnostics.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { materializeWorkspaceResources } from "#compiler/workspace-resources.js";

/**
 * Stable diagnostics artifact kind emitted by the compiler.
 */
export const COMPILER_DIAGNOSTICS_ARTIFACT_KIND = "eve-compiler-diagnostics";

/**
 * Current diagnostics artifact schema version.
 */
export const COMPILER_DIAGNOSTICS_ARTIFACT_VERSION = 2;

/**
 * Stable compile metadata artifact kind emitted by the compiler.
 */
export const COMPILE_METADATA_KIND = "eve-compile-metadata";

/**
 * Current compile metadata schema version.
 */
export const COMPILE_METADATA_VERSION = 6;

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

/**
 * Machine-readable compiler diagnostics artifact written by the compiler.
 */
export interface CompilerDiagnosticsArtifact {
  diagnostics: CompilerDiagnostic[];
  kind: typeof COMPILER_DIAGNOSTICS_ARTIFACT_KIND;
  summary: DiscoverDiagnosticsSummary;
  version: typeof COMPILER_DIAGNOSTICS_ARTIFACT_VERSION;
}

export const compilerDiagnosticsArtifactSchema = z
  .object({
    diagnostics: z.array(compilerDiagnosticSchema),
    kind: z.literal(COMPILER_DIAGNOSTICS_ARTIFACT_KIND),
    summary: discoverDiagnosticsSummarySchema,
    version: z.literal(COMPILER_DIAGNOSTICS_ARTIFACT_VERSION),
  })
  .strict();

/**
 * One artifact digest recorded in compile metadata.
 */
interface CompileArtifactDigest {
  path: string;
  sha256: string;
}

/**
 * Minimal compiler metadata artifact with versioning and hashes.
 */
export interface CompileMetadata {
  compile: {
    manifest: CompileArtifactDigest;
    moduleMap: CompileArtifactDigest;
  };
  discovery: {
    diagnostics: CompileArtifactDigest;
    manifest: CompileArtifactDigest;
    sourceGraphHash: string;
    summary: DiscoverDiagnosticsSummary;
  };
  generator: {
    name: string;
    version: string;
  };
  kind: typeof COMPILE_METADATA_KIND;
  status: "failed" | "ready";
  version: typeof COMPILE_METADATA_VERSION;
}

export interface CompilerArtifactLocations {
  readonly publishedRoot: string;
  readonly writeRoot: string;
}

/**
 * Input for writing compiler-owned source and diagnostic artifacts.
 */
interface WriteCompilerArtifactsInput {
  appRoot: string;
  artifactLocations: CompilerArtifactLocations;
  diagnostics: readonly DiscoverDiagnostic[];
  manifest: AgentSourceManifest;
  workspace?: import("#compiler/workspace-context.js").CompileWorkspaceContext;
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
 * Creates the compiler diagnostics artifact written alongside the source manifest.
 */
function createCompilerDiagnosticsArtifact(
  diagnostics: readonly CompilerDiagnostic[],
): CompilerDiagnosticsArtifact {
  return {
    diagnostics: [...diagnostics],
    kind: COMPILER_DIAGNOSTICS_ARTIFACT_KIND,
    summary: summarizeCompilerDiagnostics(diagnostics),
    version: COMPILER_DIAGNOSTICS_ARTIFACT_VERSION,
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
  diagnosticsSummary: DiscoverDiagnosticsSummary;
  discoveryManifestJson: string;
  moduleMapSource: string;
  paths: CompilerArtifactPaths;
}): CompileMetadata {
  const generator = resolveInstalledPackageInfo();
  const compiledManifestHash = createContentHash(input.compiledManifestJson);
  const discoveryManifestHash = createContentHash(input.discoveryManifestJson);
  const diagnosticsHash = createContentHash(input.diagnosticsArtifactJson);
  const moduleMapHash = createContentHash(input.moduleMapSource);

  return {
    compile: {
      manifest: {
        path: toArtifactRelativePath(input.appRoot, input.paths.compiledManifestPath),
        sha256: compiledManifestHash,
      },
      moduleMap: {
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
        sha256: discoveryManifestHash,
      },
      sourceGraphHash: createContentHash(
        `${compiledManifestHash}:${discoveryManifestHash}:${diagnosticsHash}:${moduleMapHash}`,
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
  const diagnostics = input.diagnostics.map((diagnostic) =>
    projectDiscoverDiagnostic(diagnostic, ROOT_COMPILED_AGENT_NODE_ID),
  );
  const compiledManifest = await materializeWorkspaceResources({
    compileDirectoryPath: paths.compileDirectoryPath,
    manifest: await compileAgentManifest(input.manifest, {
      diagnostics,
      workspace: input.workspace,
    }),
  });
  const diagnosticsArtifact = createCompilerDiagnosticsArtifact(diagnostics);
  const compiledManifestJson = serializeArtifactJson(compiledManifest);
  const discoveryManifestJson = serializeArtifactJson(input.manifest);
  const diagnosticsArtifactJson = serializeArtifactJson(diagnosticsArtifact);
  const moduleMapSource = createCompiledModuleMapSource({
    manifest: compiledManifest,
    moduleMapPath: publishedPaths.moduleMapPath,
  });
  const metadata = createCompileMetadata({
    appRoot: input.appRoot,
    compiledManifestJson,
    diagnosticsArtifactJson,
    diagnosticsSummary: diagnosticsArtifact.summary,
    discoveryManifestJson,
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
  await Promise.all([
    writeFile(paths.compiledManifestPath, compiledManifestJson),
    writeFile(paths.diagnosticsPath, diagnosticsArtifactJson),
    writeFile(paths.discoveryManifestPath, discoveryManifestJson),
    writeFile(paths.moduleMapPath, moduleMapSource),
    writeFile(paths.compileMetadataPath, metadataJson),
  ]);

  return {
    compiledManifest,
    diagnosticsArtifact,
    metadata,
    moduleMapSource,
    paths,
  };
}

function createContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serializeArtifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toArtifactRelativePath(appRoot: string, targetPath: string): string {
  return normalizeLogicalPath(relative(resolve(appRoot), targetPath));
}
