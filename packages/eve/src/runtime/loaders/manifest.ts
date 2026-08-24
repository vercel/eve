import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { loadCompiledArtifactEnvelope } from "#runtime/loaders/compiled-artifact-set.js";

interface LoadCompiledManifestInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/** Error raised when the validated compiled envelope cannot be loaded. */
export class LoadCompiledManifestError extends Error {
  readonly manifestPath?: string;

  constructor(message: string, manifestPath?: string) {
    super(message);
    this.name = "LoadCompiledManifestError";
    if (manifestPath !== undefined) this.manifestPath = manifestPath;
  }
}

/** Projects the manifest from one complete, digest-validated artifact envelope. */
export async function loadCompiledManifest(
  input: LoadCompiledManifestInput,
): Promise<CompiledAgentManifest> {
  return (await loadCompiledManifestWithDiagnostics(input)).manifest;
}

/** Projects the manifest and diagnostics from one complete validated envelope. */
export async function loadCompiledManifestWithDiagnostics(
  input: LoadCompiledManifestInput,
): Promise<{
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
}> {
  try {
    const { diagnostics, manifest } = await loadCompiledArtifactEnvelope(input);
    return { diagnostics, manifest };
  } catch (error) {
    const manifestPath =
      input.compiledArtifactsSource.kind === "disk"
        ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot)
            .compiledManifestPath
        : undefined;
    throw new LoadCompiledManifestError(formatLoadErrorMessage(error), manifestPath);
  }
}

function formatLoadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown manifest load failure.";
}
