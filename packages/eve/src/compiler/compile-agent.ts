import { join } from "node:path";

import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";
import {
  formatCompilerDiagnostic,
  hasCompilerErrors,
  summarizeCompilerDiagnostics,
} from "#shared/compiler-diagnostics.js";
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
import { ChannelRoutePlanningError } from "#compiler/channel-route-plan.js";
import { SourceNormalizationError } from "#compiler/normalize-helpers.js";
import type { BuiltInWorkflowWorldTarget } from "#internal/workflow/world-target.js";

/**
 * Input for compiling the current authored agent into framework-owned
 * discovery artifacts.
 */
export interface CompileAgentInput {
  /** Effective native World when the root config does not select one. */
  defaultWorkflowWorld?: BuiltInWorkflowWorldTarget;
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
 * Error raised when compiler artifacts were written but diagnostics contain
 * errors.
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

/** Error raised when compilation aborts before a successful artifact can be written. */
export class CompileAgentDiagnosticError extends Error {
  readonly diagnostic: CompilerDiagnostic;
  readonly diagnostics: readonly CompilerDiagnostic[];

  constructor(
    diagnostic: CompilerDiagnostic,
    previousDiagnostics: readonly CompilerDiagnostic[] = [],
  ) {
    const diagnostics = [...previousDiagnostics, diagnostic];
    super(formatCompileAgentErrorLines(diagnostics).join("\n"));
    this.name = "CompileAgentDiagnosticError";
    this.diagnostic = diagnostic;
    this.diagnostics = diagnostics;
  }
}

/**
 * Runs discovery and compilation, writes compiler-owned artifacts, and throws
 * when diagnostics contain errors.
 */
export async function compileAgent(input: CompileAgentInput = {}): Promise<CompileAgentResult> {
  const discovered = await discoverAgentForCompilation(input);
  const artifactsRoot = join(discovered.project.appRoot, ".eve");
  const result = await writeAgentCompilation(
    discovered,
    {
      publishedRoot: artifactsRoot,
      writeRoot: artifactsRoot,
    },
    input.defaultWorkflowWorld ?? resolveDefaultWorkflowWorld(),
  );

  return finishAgentCompilation(result, CompileAgentError.fromDurableArtifacts);
}

/**
 * Compiles an agent into a caller-owned workspace. Artifacts are written to
 * `writeRoot`, while metadata and module maps record paths under the stable
 * `publishedRoot` where the caller will expose them.
 */
export async function compileAgentInWorkspace(input: {
  readonly artifactLocations: CompilerArtifactLocations;
  readonly defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
  readonly startPath: string;
}): Promise<CompileAgentResult> {
  const discovered = await discoverAgentForCompilation({ startPath: input.startPath });
  const result = await writeAgentCompilation(
    discovered,
    input.artifactLocations,
    input.defaultWorkflowWorld,
  );

  return finishAgentCompilation(result, CompileAgentError.fromTransientArtifacts);
}

interface DiscoveredAgentCompilation {
  readonly diagnostics: CompilerDiagnostic[];
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
  defaultWorkflowWorld: BuiltInWorkflowWorldTarget,
): Promise<CompileAgentResult> {
  let writtenArtifacts: Awaited<ReturnType<typeof writeCompilerArtifacts>>;
  try {
    writtenArtifacts = await writeCompilerArtifacts({
      appRoot: discovered.project.appRoot,
      artifactLocations,
      defaultWorkflowWorld,
      diagnostics: discovered.diagnostics,
      manifest: discovered.manifest,
    });
  } catch (error) {
    if (error instanceof ChannelRoutePlanningError || error instanceof SourceNormalizationError) {
      throw new CompileAgentDiagnosticError(error.diagnostic, discovered.diagnostics);
    }
    throw error;
  }

  return {
    diagnostics: writtenArtifacts.diagnosticsArtifact.diagnostics,
    manifest: writtenArtifacts.compiledManifest,
    metadata: writtenArtifacts.metadata,
    paths: writtenArtifacts.paths,
    project: discovered.project,
  };
}

function resolveDefaultWorkflowWorld(): BuiltInWorkflowWorldTarget {
  return process.env.VERCEL ? "vercel" : "local";
}

function finishAgentCompilation(
  result: CompileAgentResult,
  createError: (result: CompileAgentResult) => CompileAgentError,
): CompileAgentResult {
  if (hasCompilerErrors(result.diagnostics)) {
    throw createError(result);
  }

  reportCompilerWarnings(result.diagnostics);

  return result;
}

function reportCompilerWarnings(diagnostics: readonly CompilerDiagnostic[]): void {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");

  if (warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    console.warn(formatCompilerDiagnostic(warning));
  }
}

function formatCompileAgentErrorLines(diagnostics: readonly CompilerDiagnostic[]): string[] {
  const summary = summarizeCompilerDiagnostics(diagnostics);
  const lines: string[] = [
    `Compilation failed with ${summary.errors} error(s) and ${summary.warnings} warning(s).`,
  ];

  if (diagnostics.length === 0) {
    return lines;
  }

  lines.push("Compiler diagnostics:");

  for (const diagnostic of diagnostics) {
    lines.push(formatCompilerDiagnostic(diagnostic, { bullet: true }));
  }

  return lines;
}
