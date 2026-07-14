import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";
import type {
  DevelopmentNitroArtifactsConfig,
  ProductionNitroArtifactsConfig,
} from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Runtime-artifacts wiring for the dev server: routes read compiled
 * artifacts from the authored app root via the snapshot pointer so hot
 * reload can swap them.
 */
export function createDevelopmentNitroArtifactsConfig(input: {
  readonly appRoot: string;
}): DevelopmentNitroArtifactsConfig {
  return {
    appRoot: input.appRoot,
    devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot),
    kind: "development",
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  };
}

/**
 * Runtime-artifacts wiring for built output: routes require the artifacts
 * bundled into the server at build time and never touch the filesystem.
 */
export function createProductionNitroArtifactsConfig(): ProductionNitroArtifactsConfig {
  return {
    kind: "production",
  };
}
