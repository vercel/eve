import { join } from "node:path";

import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverAgent } from "#discover/discover-agent.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  type CompilerArtifactLocations,
  type CompilerArtifactPaths,
  writeCompilerArtifacts,
} from "#compiler/artifacts.js";
import { type CompileMetadata } from "#compiler/artifact-contract.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { summarizeCompilerDiagnostics, type CompilerDiagnostic } from "#compiler/diagnostics.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import { formatDiagnosticSources, reportDiscoverWarnings } from "#compiler/report-warnings.js";
import type { AuthoredModuleGraph } from "#internal/authored-module-graph.js";

interface CompileAgentInput {
  developmentExtensions?: DevelopmentExtensionSelection;
  source?: ProjectSource;
  startPath?: string;
}

export interface CompileAgentResult {
  diagnostics: CompilerDiagnostic[];
  manifest: CompiledAgentManifest;
  metadata: CompileMetadata;
  paths: CompilerArtifactPaths;
  project: ResolvedDiscoveryProject;
}

export class CompileAgentError extends Error {
  readonly result: CompileAgentResult;

  private constructor(result: CompileAgentResult, message: string) {
    super(message);
    this.name = "CompileAgentError";
    this.result = result;
  }

  static fromDurableArtifacts(result: CompileAgentResult): CompileAgentError {
    const [summary, ...diagnostics] = formatCompileAgentErrorLines(result.diagnostics);
    return new CompileAgentError(
      result,
      [summary, `Diagnostics artifact: ${result.paths.diagnosticsPath}`, ...diagnostics].join("\n"),
    );
  }

  static fromTransientArtifacts(result: CompileAgentResult): CompileAgentError {
    return new CompileAgentError(
      result,
      formatCompileAgentErrorLines(result.diagnostics).join("\n"),
    );
  }
}

export async function compileAgent(input: CompileAgentInput = {}): Promise<CompileAgentResult> {
  const discovered = await discoverAgentForCompilation(input);
  const artifactsRoot = join(discovered.project.appRoot, ".eve");
  const { compileResult } = await writeAgentCompilation(discovered, {
    publishedRoot: artifactsRoot,
    writeRoot: artifactsRoot,
  });

  return finishAgentCompilation(compileResult, CompileAgentError.fromDurableArtifacts);
}

export async function compileAgentInWorkspace(input: {
  readonly artifactLocations: CompilerArtifactLocations;
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly startPath: string;
}): Promise<{
  readonly compileResult: CompileAgentResult;
  readonly moduleGraph: AuthoredModuleGraph;
}> {
  const discovered = await discoverAgentForCompilation({
    developmentExtensions: input.developmentExtensions,
    startPath: input.startPath,
  });
  const { compileResult, moduleGraph } = await writeAgentCompilation(
    discovered,
    input.artifactLocations,
  );

  return {
    compileResult: finishAgentCompilation(compileResult, CompileAgentError.fromTransientArtifacts),
    moduleGraph,
  };
}

interface DiscoveredAgentCompilation {
  readonly developmentExtensions: DevelopmentExtensionSelection | undefined;
  readonly diagnostics: DiscoverDiagnostic[];
  readonly manifest: AgentSourceManifest;
  readonly project: ResolvedDiscoveryProject;
}

async function discoverAgentForCompilation(
  input: CompileAgentInput,
): Promise<DiscoveredAgentCompilation> {
  const source = input.source ?? createDiskProjectSource();
  const project = await resolveDiscoveryProject(input.startPath, { source });
  const discoveryResult = await discoverAgent({ ...project, source });

  return {
    developmentExtensions: input.developmentExtensions,
    diagnostics: discoveryResult.diagnostics,
    manifest: discoveryResult.manifest,
    project,
  };
}

async function writeAgentCompilation(
  discovered: DiscoveredAgentCompilation,
  artifactLocations: CompilerArtifactLocations,
): Promise<{
  readonly compileResult: CompileAgentResult;
  readonly moduleGraph: AuthoredModuleGraph;
}> {
  const writtenArtifacts = await writeCompilerArtifacts({
    appRoot: discovered.project.appRoot,
    artifactLocations,
    diagnostics: discovered.diagnostics,
    developmentExtensions: discovered.developmentExtensions,
    manifest: discovered.manifest,
  });

  return {
    compileResult: {
      diagnostics: writtenArtifacts.diagnosticsArtifact.diagnostics,
      manifest: writtenArtifacts.compiledManifest,
      metadata: writtenArtifacts.metadata,
      paths: writtenArtifacts.paths,
      project: discovered.project,
    },
    moduleGraph: writtenArtifacts.moduleGraph,
  };
}

function finishAgentCompilation(
  result: CompileAgentResult,
  createError: (result: CompileAgentResult) => CompileAgentError,
): CompileAgentResult {
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw createError(result);
  }

  reportDiscoverWarnings(result.diagnostics);

  return result;
}

function formatCompileAgentErrorLines(diagnostics: readonly CompilerDiagnostic[]): string[] {
  const summary = summarizeCompilerDiagnostics(diagnostics);
  const lines: string[] = [
    `Discovery failed with ${summary.errors} error(s) and ${summary.warnings} warning(s).`,
  ];

  if (diagnostics.length === 0) {
    return lines;
  }

  lines.push("Discovery diagnostics:");

  for (const diagnostic of diagnostics) {
    lines.push(`- ${formatDiagnosticSeverity(diagnostic.severity)}: ${diagnostic.message}`);
    lines.push(`  source: ${formatDiagnosticSources(diagnostic)}`);
  }

  return lines;
}

function formatDiagnosticSeverity(severity: DiscoverDiagnostic["severity"]): string {
  return severity === "error" ? "Error" : "Warning";
}
