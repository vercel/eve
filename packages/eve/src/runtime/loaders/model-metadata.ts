import { readFile } from "node:fs/promises";

import { modelMetadataSchema, type ModelMetadata } from "#internal/model-catalog.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

/** Loads the model metadata snapshot the build baked into its compiled artifacts. */
export async function loadModelMetadata(
  source: RuntimeCompiledArtifactsSource,
): Promise<ModelMetadata> {
  if (source.kind === "bundled") {
    const metadata = readBundledCompiledArtifacts()?.modelMetadata;
    if (metadata === undefined) {
      throw new Error(
        "The bundled compiled artifacts have no model metadata. Rebuild with `eve build`.",
      );
    }
    return metadata;
  }
  const path = resolveRuntimeCompilerArtifactPaths(source.appRoot).modelMetadataPath;
  try {
    return modelMetadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `The compiled artifacts have no model metadata at "${path}". Rebuild with \`eve build\`, or restart \`eve dev\`.`,
        { cause: error },
      );
    }
    throw error;
  }
}
