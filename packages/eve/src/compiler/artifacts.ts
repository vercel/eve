import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import { summarizeDiscoverDiagnostics } from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { materializeWorkspaceResources } from "#compiler/workspace-resources.js";

/**
 * Stable diagnostics artifact kind emitted by the compiler.
 */
const DISCOVERY_DIAGNOSTICS_ARTIFACT_KIND = "eve-discovery-diagnostics";

/**
 * Current diagnostics artifact schema version.
 */
const DISCOVERY_DIAGNOSTICS_ARTIFACT_VERSION = 1;

/**
 * Stable compile metadata artifact kind emitted by the compiler.
 */
export const COMPILE_METADATA_KIND = "eve-compile-metadata";

/**
 * Current compile metadata schema version.
 */
export const COMPILE_METADATA_VERSION = 5;

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
 * Machine-readable discovery diagnostics artifact written by the compiler.
 */
interface DiscoveryDiagnosticsArtifact {
  diagnostics: DiscoverDiagnostic[];
  kind: typeof DISCOVERY_DIAGNOSTICS_ARTIFACT_KIND;
  summary: DiscoverDiagnosticsSummary;
  version: typeof DISCOVERY_DIAGNOSTICS_ARTIFACT_VERSION;
}

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
 * Input for writing compiler-owned discovery artifacts.
 */
interface WriteCompilerArtifactsInput {
  appRoot: string;
  artifactLocations: CompilerArtifactLocations;
  diagnostics: readonly DiscoverDiagnostic[];
  manifest: AgentSourceManifest;
}

/**
 * Result of writing compiler-owned artifacts.
 */
interface WriteCompilerArtifactsResult {
  compiledManifest: CompiledAgentManifest;
  diagnosticsArtifact: DiscoveryDiagnosticsArtifact;
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
 * Creates the diagnostics artifact written alongside the source manifest.
 */
function createDiscoveryDiagnosticsArtifact(
  diagnostics: readonly DiscoverDiagnostic[],
): DiscoveryDiagnosticsArtifact {
  return {
    diagnostics: [...diagnostics],
    kind: DISCOVERY_DIAGNOSTICS_ARTIFACT_KIND,
    summary: summarizeDiscoverDiagnostics(diagnostics),
    version: DISCOVERY_DIAGNOSTICS_ARTIFACT_VERSION,
  };
}

/**
 * Creates deterministic compile metadata from already-serialized artifact
 * payloads.
 */
export function createCompileMetadata(input: {
  appRoot: string;
  diagnosticsArtifactJson: string;
  diagnosticsSummary: DiscoverDiagnosticsSummary;
  discoveryManifestJson: string;
  moduleMapSource: string;
  paths: CompilerArtifactPaths;
}): CompileMetadata {
  const generator = resolveInstalledPackageInfo();
  const manifestHash = createContentHash(input.discoveryManifestJson);
  const diagnosticsHash = createContentHash(input.diagnosticsArtifactJson);
  const moduleMapHash = createContentHash(input.moduleMapSource);

  return {
    compile: {
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
        sha256: manifestHash,
      },
      sourceGraphHash: createContentHash(`${manifestHash}:${diagnosticsHash}:${moduleMapHash}`),
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
  const diagnosticsArtifact = createDiscoveryDiagnosticsArtifact(input.diagnostics);
  const compiledManifest = await materializeWorkspaceResources({
    compileDirectoryPath: paths.compileDirectoryPath,
    manifest: await compileAgentManifest(input.manifest),
  });
  const compiledManifestJson = serializeArtifactJson(compiledManifest);
  const discoveryManifestJson = serializeArtifactJson(input.manifest);
  const diagnosticsArtifactJson = serializeArtifactJson(diagnosticsArtifact);
  const moduleMapSource = createCompiledModuleMapSource({
    manifest: compiledManifest,
    moduleMapPath: publishedPaths.moduleMapPath,
  });
  const metadata = createCompileMetadata({
    appRoot: input.appRoot,
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
