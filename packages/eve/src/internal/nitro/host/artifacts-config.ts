import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";
import type {
  DevelopmentNitroArtifactsConfig,
  ProductionNitroArtifactsConfig,
} from "#internal/nitro/routes/runtime-artifacts.js";

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

export function createProductionNitroArtifactsConfig(): ProductionNitroArtifactsConfig {
  return {
    kind: "production",
  };
}
