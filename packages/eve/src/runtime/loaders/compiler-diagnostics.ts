import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { loadCompiledArtifactEnvelope } from "#runtime/loaders/compiled-artifact-set.js";

/** Error raised when the validated compiler diagnostics envelope cannot be loaded. */
export class LoadCompilerDiagnosticsArtifactError extends Error {
  readonly diagnosticsPath?: string;

  constructor(message: string, diagnosticsPath?: string) {
    super(message);
    this.name = "LoadCompilerDiagnosticsArtifactError";
    if (diagnosticsPath !== undefined) this.diagnosticsPath = diagnosticsPath;
  }
}

/** Projects diagnostics from one complete, digest-validated artifact envelope. */
export async function loadCompilerDiagnosticsArtifact(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  /** Retained for callers that already hold the envelope's manifest. */
  readonly manifest: CompiledAgentManifest;
}): Promise<CompilerDiagnosticsArtifact> {
  try {
    return (await loadCompiledArtifactEnvelope(input)).diagnostics;
  } catch (error) {
    const diagnosticsPath =
      input.compiledArtifactsSource.kind === "disk"
        ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot).diagnosticsPath
        : undefined;
    throw new LoadCompilerDiagnosticsArtifactError(
      error instanceof Error ? error.message : "Unknown diagnostics load failure.",
      diagnosticsPath,
    );
  }
}
