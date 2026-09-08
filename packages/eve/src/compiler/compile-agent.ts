import { join } from "node:path";

import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverAgent } from "#discover/discover-agent.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  type CompileMetadata,
  type CompilerArtifactLocations,
  type CompilerArtifactPaths,
  writeCompilerArtifacts,
} from "#compiler/artifacts.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { summarizeCompilerDiagnostics, type CompilerDiagnostic } from "#compiler/diagnostics.js";

/**
 * Input for compiling the current authored agent into framework-owned
 * discovery artifacts.
 */
export interface CompileAgentInput {
  /**
   * Optional {@link ProjectSource} used for discovery reads. Defaults to a
   * disk-backed source so production callers keep their current behaviour.
   */
  source?: ProjectSource;
  startPath?: string;
}

/**
 * Result of compiling the current authored agent into framework-owned
 * artifacts.
 */
export interface CompileAgentResult {
  diagnostics: CompilerDiagnostic[];
  manifest: CompiledAgentManifest;
  metadata: CompileMetadata;
  paths: CompilerArtifactPaths;
  project: ResolvedDiscoveryProject;
}

/**
 * Error raised when discovery artifacts were written but discovery still
 * contained errors.
 */
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

/**
 * Runs discovery, writes compiler-owned artifacts, and throws when discovery
 * produced errors.
 */
export async function compileAgent(input: CompileAgentInput = {}): Promise<CompileAgentResult> {
  const discovered = await discoverAgentForCompilation(input);
  const artifactsRoot = join(discovered.project.appRoot, ".eve");
  const result = await writeAgentCompilation(discovered, {
    publishedRoot: artifactsRoot,
    writeRoot: artifactsRoot,
  });

  return finishAgentCompilation(result, CompileAgentError.fromDurableArtifacts);
}

/**
 * Compiles an agent into a caller-owned workspace. Artifacts are written to
 * `writeRoot`, while metadata and module maps record paths under the stable
 * `publishedRoot` where the caller will expose them.
 */
export async function compileAgentInWorkspace(input: {
  readonly artifactLocations: CompilerArtifactLocations;
  readonly startPath: string;
  readonly workspace?: import("#compiler/workspace-context.js").CompileWorkspaceContext;
}): Promise<CompileAgentResult> {
  const discovered = await discoverAgentForCompilation({ startPath: input.startPath });
  const result = await writeAgentCompilation(discovered, input.artifactLocations, input.workspace);

  return finishAgentCompilation(result, CompileAgentError.fromTransientArtifacts);
}

interface DiscoveredAgentCompilation {
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
    diagnostics: discoveryResult.diagnostics,
    manifest: discoveryResult.manifest,
    project,
  };
}

async function writeAgentCompilation(
  discovered: DiscoveredAgentCompilation,
  artifactLocations: CompilerArtifactLocations,
  workspace?: import("#compiler/workspace-context.js").CompileWorkspaceContext,
): Promise<CompileAgentResult> {
  const writtenArtifacts = await writeCompilerArtifacts({
    appRoot: discovered.project.appRoot,
    artifactLocations,
    diagnostics: discovered.diagnostics,
    manifest: discovered.manifest,
    workspace,
  });

  return {
    diagnostics: writtenArtifacts.diagnosticsArtifact.diagnostics,
    manifest: writtenArtifacts.compiledManifest,
    metadata: writtenArtifacts.metadata,
    paths: writtenArtifacts.paths,
    project: discovered.project,
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

function reportDiscoverWarnings(diagnostics: readonly CompilerDiagnostic[]): void {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");

  if (warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    console.warn(
      `Warning [${warning.code}]: ${warning.message}\n  source: ${formatDiagnosticSources(warning)}`,
    );
  }
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

function formatDiagnosticSources(diagnostic: CompilerDiagnostic): string {
  return diagnostic.sources
    .map((source) => source.sourcePath ?? source.logicalPath ?? source.sourceId ?? source.nodeId)
    .join(", ");
}

function formatDiagnosticSeverity(severity: DiscoverDiagnostic["severity"]): string {
  return severity === "error" ? "Error" : "Warning";
}
