import {
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";

/**
 * Creates a disk-backed artifact source for dev/build flows that may need to
 * hydrate authored modules directly from source files.
 */
export function createAuthoredSourceRuntimeCompiledArtifactsSource(
  appRoot: string,
): RuntimeDiskCompiledArtifactsSource {
  return createDiskRuntimeCompiledArtifactsSource(appRoot, {
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  });
}
