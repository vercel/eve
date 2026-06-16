import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { hasDiscoverErrors, summarizeDiscoverDiagnostics } from "#discover/diagnostics.js";
import { discoverAgent } from "#discover/discover-agent.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import {
  type CompileMetadata,
  type CompilerArtifactPaths,
  writeCompilerArtifacts,
} from "#compiler/artifacts.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";

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
  diagnostics: DiscoverDiagnostic[];
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

  constructor(result: CompileAgentResult) {
    super(
      formatCompileAgentErrorMessage({
        diagnostics: result.diagnostics,
        diagnosticsPath: result.paths.diagnosticsPath,
      }),
    );
    this.name = "CompileAgentError";
    this.result = result;
  }
}

/**
 * Runs discovery, writes compiler-owned artifacts, and throws when discovery
 * produced errors.
 */
export async function compileAgent(input: CompileAgentInput = {}): Promise<CompileAgentResult> {
  const source = input.source ?? createDiskProjectSource();
  const project = await resolveDiscoveryProject(input.startPath, { source });
  const discoveryResult = await discoverAgent({ ...project, source });
  const writtenArtifacts = await writeCompilerArtifacts({
    appRoot: project.appRoot,
    diagnostics: discoveryResult.diagnostics,
    manifest: discoveryResult.manifest,
  });
  const result: CompileAgentResult = {
    diagnostics: discoveryResult.diagnostics,
    manifest: writtenArtifacts.compiledManifest,
    metadata: writtenArtifacts.metadata,
    paths: writtenArtifacts.paths,
    project,
  };

  if (hasDiscoverErrors(discoveryResult.diagnostics)) {
    throw new CompileAgentError(result);
  }

  reportDiscoverWarnings(discoveryResult.diagnostics);

  return result;
}

function reportDiscoverWarnings(diagnostics: readonly DiscoverDiagnostic[]): void {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");

  if (warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    console.warn(`Warning [${warning.code}]: ${warning.message}\n  source: ${warning.sourcePath}`);
  }
}

function formatCompileAgentErrorMessage(input: {
  diagnostics: readonly DiscoverDiagnostic[];
  diagnosticsPath?: string;
}): string {
  const summary = summarizeDiscoverDiagnostics(input.diagnostics);
  const lines: string[] = [
    `Discovery failed with ${summary.errors} error(s) and ${summary.warnings} warning(s).`,
  ];

  if (input.diagnosticsPath !== undefined) {
    lines.push(`Diagnostics artifact: ${input.diagnosticsPath}`);
  }

  if (input.diagnostics.length === 0) {
    return lines.join("\n");
  }

  lines.push("Discovery diagnostics:");

  for (const diagnostic of input.diagnostics) {
    lines.push(`- ${formatDiagnosticSeverity(diagnostic.severity)}: ${diagnostic.message}`);
    lines.push(`  source: ${diagnostic.sourcePath}`);
  }

  return lines.join("\n");
}

function formatDiagnosticSeverity(severity: DiscoverDiagnostic["severity"]): string {
  return severity === "error" ? "Error" : "Warning";
}
