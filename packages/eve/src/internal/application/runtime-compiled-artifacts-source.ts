import {
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";

export function createAuthoredSourceRuntimeCompiledArtifactsSource(
  appRoot: string,
): RuntimeDiskCompiledArtifactsSource {
  return createDiskRuntimeCompiledArtifactsSource(appRoot, {
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  });
}
