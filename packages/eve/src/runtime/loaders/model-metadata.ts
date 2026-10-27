import { readFile } from "node:fs/promises";

import {
  createModelMetadata,
  modelMetadataSchema,
  type ModelMetadata,
} from "#internal/model-catalog.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

/**
 * Loads the model metadata snapshot the build baked into its compiled artifacts. Artifacts
 * without one load as an empty snapshot, so selections that need metadata fail with the same
 * error as a model the catalog didn't list.
 */
export async function loadModelMetadata(
  source: RuntimeCompiledArtifactsSource,
): Promise<ModelMetadata> {
  if (source.kind === "bundled") {
    return readBundledCompiledArtifacts()?.modelMetadata ?? createModelMetadata(null);
  }
  const path = resolveRuntimeCompilerArtifactPaths(source.appRoot).modelMetadataPath;
  try {
    return modelMetadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return createModelMetadata(null);
    }
    throw error;
  }
}
