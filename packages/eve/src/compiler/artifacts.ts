import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#compiler/artifact-contract.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  projectDiscoverDiagnostic,
  summarizeCompilerDiagnostics,
  type CompilerDiagnostic,
} from "#compiler/diagnostics.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { compileAgentManifestWithModuleGraph } from "#compiler/normalize-manifest.js";
import type { AuthoredModuleGraph } from "#internal/authored-module-graph.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import { materializeWorkspaceResources } from "#compiler/workspace-resources.js";
import { toErrorMessage } from "#shared/errors.js";
import { createSandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";

const COMPILER_DIAGNOSTICS_ARTIFACT_KIND = "eve-compiler-diagnostics";

const COMPILER_DIAGNOSTICS_ARTIFACT_VERSION = 2;

export interface CompilerArtifactPaths {
  appRoot: string;
  compiledManifestPath: string;
  compileDirectoryPath: string;
  compileMetadataPath: string;
  diagnosticsPath: string;
  discoveryManifestPath: string;
  discoveryDirectoryPath: string;
  modelMetadataPath: string;
  moduleMapPath: string;
  sandboxPreparedArtifactsPath: string;
}

interface CompilerDiagnosticsArtifact {
  diagnostics: CompilerDiagnostic[];
  kind: typeof COMPILER_DIAGNOSTICS_ARTIFACT_KIND;
  summary: DiscoverDiagnosticsSummary;
  version: typeof COMPILER_DIAGNOSTICS_ARTIFACT_VERSION;
}

export interface CompilerArtifactLocations {
  readonly publishedRoot: string;
  readonly writeRoot: string;
}

interface WriteCompilerArtifactsInput {
  appRoot: string;
  developmentExtensions?: DevelopmentExtensionSelection;
  artifactLocations: CompilerArtifactLocations;
  diagnostics: readonly DiscoverDiagnostic[];
  manifest: AgentSourceManifest;
}

interface WriteCompilerArtifactsResult {
  compiledManifest: CompiledAgentManifest;
  diagnosticsArtifact: CompilerDiagnosticsArtifact;
  metadata: CompileMetadata;
  moduleGraph: AuthoredModuleGraph;
  moduleMapSource: string;
  paths: CompilerArtifactPaths;
}

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
    modelMetadataPath: join(compileDirectoryPath, "model-metadata.json"),
    moduleMapPath: join(compileDirectoryPath, "module-map.mjs"),
    sandboxPreparedArtifactsPath: join(compileDirectoryPath, "sandbox-prepared-artifacts.json"),
  };
}

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
  const modelCatalog = createCompiledRuntimeModelCatalogLoader(input.manifest.appRoot);
  if ((await modelCatalog.loadModelMetadata()).fetchedAt === null) {
    diagnostics.push(createModelMetadataUnavailableDiagnostic(paths.modelMetadataPath));
  }
  const compiled = await compileAgentManifestWithModuleGraph(input.manifest, {
    developmentExtensions: input.developmentExtensions,
    diagnostics,
    modelCatalog,
  }).catch((error: unknown) => {
    throw withDiscoveryErrors(error, input.diagnostics);
  });
  const compiledManifest = await materializeWorkspaceResources({
    compileDirectoryPath: paths.compileDirectoryPath,
    manifest: compiled.manifest,
  });
  const modelMetadata = await modelCatalog.loadModelMetadata();
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
  const sandboxPreparedArtifactsJson = serializeArtifactJson(
    createSandboxPreparedArtifactsManifest([]),
  );

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
    writeFile(paths.modelMetadataPath, serializeArtifactJson(modelMetadata)),
    writeFile(paths.sandboxPreparedArtifactsPath, sandboxPreparedArtifactsJson),
  ]);

  return {
    compiledManifest,
    diagnosticsArtifact,
    metadata,
    moduleGraph: compiled.moduleGraph,
    moduleMapSource,
    paths,
  };
}

function withDiscoveryErrors(error: unknown, diagnostics: readonly DiscoverDiagnostic[]): unknown {
  const discoveryErrors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (discoveryErrors.length === 0) return error;
  return new Error(
    [
      `Discovery failed with ${discoveryErrors.length} error(s):`,
      ...discoveryErrors.map(
        (diagnostic) => `- ${diagnostic.message}\n  source: ${diagnostic.sourcePath}`,
      ),
      `Compilation then stopped: ${toErrorMessage(error)}`,
    ].join("\n"),
    { cause: error },
  );
}

function createModelMetadataUnavailableDiagnostic(modelMetadataPath: string): CompilerDiagnostic {
  return {
    code: "compile/model-metadata-unavailable",
    message:
      "The AI Gateway model catalog was unavailable, so this build has no model metadata. " +
      "Runtime model selections that omit modelContextWindowTokens, such as dynamic models and " +
      "ctx.agent() model overrides, fail until you rebuild with network access to " +
      "ai-gateway.vercel.sh or set modelContextWindowTokens on each selection.",
    severity: "warning",
    sources: [{ nodeId: ROOT_COMPILED_AGENT_NODE_ID, sourcePath: modelMetadataPath }],
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
