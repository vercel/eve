import type { CompileMetadata } from "#protocol/compile-metadata.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { loadCompiledArtifactEnvelope } from "#runtime/loaders/compiled-artifact-set.js";

/** Error raised when the validated compile metadata envelope cannot be loaded. */
export class LoadCompileMetadataError extends Error {
  readonly metadataPath?: string;

  constructor(message: string, metadataPath?: string) {
    super(message);
    this.name = "LoadCompileMetadataError";
    if (metadataPath !== undefined) this.metadataPath = metadataPath;
  }
}

/** Projects metadata from one complete, digest-validated artifact envelope. */
export async function loadCompileMetadata(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<CompileMetadata> {
  try {
    return (await loadCompiledArtifactEnvelope(input)).metadata;
  } catch (error) {
    const metadataPath =
      input.compiledArtifactsSource.kind === "disk"
        ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot)
            .compileMetadataPath
        : undefined;
    throw new LoadCompileMetadataError(
      error instanceof Error ? error.message : "Unknown compile metadata load failure.",
      metadataPath,
    );
  }
}
