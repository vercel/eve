import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { loadCompiledArtifactSet } from "#runtime/loaders/compiled-artifact-set.js";

interface LoadCompiledModuleMapInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/** Error raised when the complete artifact set cannot hydrate its module map. */
export class LoadCompiledModuleMapError extends Error {
  readonly moduleMapPath?: string;

  constructor(message: string, moduleMapPath?: string) {
    super(message);
    this.name = "LoadCompiledModuleMapError";
    if (moduleMapPath !== undefined) this.moduleMapPath = moduleMapPath;
  }
}

/** Projects the module map from one complete, digest-validated artifact set. */
export async function loadCompiledModuleMap(
  input: LoadCompiledModuleMapInput,
): Promise<CompiledModuleMap> {
  try {
    return (await loadCompiledArtifactSet(input)).moduleMap;
  } catch (error) {
    const moduleMapPath =
      input.compiledArtifactsSource.kind === "disk"
        ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot).moduleMapPath
        : undefined;
    throw new LoadCompiledModuleMapError(
      error instanceof Error ? error.message : "Unknown module-map load failure.",
      moduleMapPath,
    );
  }
}
