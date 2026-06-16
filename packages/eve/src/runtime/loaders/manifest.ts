import { type CompiledAgentManifest, compiledAgentManifestSchema } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { formatValidationError } from "#runtime/validation.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

const BUNDLED_MANIFEST_SOURCE = "bundled compiled manifest";

/**
 * Input for loading the compiled source manifest from disk or the bundled
 * runtime alias.
 */
interface LoadCompiledManifestInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/**
 * Error raised when the compiled manifest cannot be loaded or validated.
 */
export class LoadCompiledManifestError extends Error {
  readonly manifestPath?: string;

  constructor(message: string, manifestPath?: string) {
    super(message);
    this.name = "LoadCompiledManifestError";

    if (manifestPath !== undefined) {
      this.manifestPath = manifestPath;
    }
  }
}

/**
 * Loads and validates the compiler-owned source manifest.
 */
export async function loadCompiledManifest(
  input: LoadCompiledManifestInput,
): Promise<CompiledAgentManifest> {
  const manifestPath =
    input.compiledArtifactsSource.kind === "disk"
      ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot)
          .compiledManifestPath
      : undefined;

  if (manifestPath !== undefined) {
    const { readFile } = await import("node:fs/promises");
    let manifestJson: unknown;

    try {
      manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new LoadCompiledManifestError(formatLoadErrorMessage(error), manifestPath);
    }

    return parseCompiledManifest(manifestJson, manifestPath);
  }

  const bundledArtifacts = readBundledCompiledArtifacts();

  if (bundledArtifacts !== null) {
    return parseCompiledManifest(bundledArtifacts.manifest, BUNDLED_MANIFEST_SOURCE);
  }

  throw new LoadCompiledManifestError(
    "Compiled manifest is unavailable without an app root or bundled compiled artifacts.",
    BUNDLED_MANIFEST_SOURCE,
  );
}

function parseCompiledManifest(value: unknown, manifestPath: string): CompiledAgentManifest {
  const parsed = compiledAgentManifestSchema.safeParse(value);

  if (!parsed.success) {
    throw new LoadCompiledManifestError(
      `Expected "${manifestPath}" to contain a valid compiled eve agent manifest. ${formatValidationError(parsed.error)}`,
      manifestPath,
    );
  }

  return parsed.data;
}

function formatLoadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown manifest load failure.";
}
