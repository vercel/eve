import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Artifacts config serialized into virtual Nitro handlers so route handlers
 * can resolve compiled artifacts without a global runtime configuration store.
 */
export interface NitroArtifactsConfigInput extends NitroArtifactsConfig {
  readonly appRoot: string;
  readonly dev: boolean;
}

/**
 * Creates the artifacts config baked into Nitro virtual handlers.
 */
export function createNitroArtifactsConfig(input: {
  readonly appRoot: string;
  readonly dev: boolean;
}): NitroArtifactsConfigInput {
  if (!input.dev) {
    return {
      appRoot: input.appRoot,
      dev: input.dev,
    };
  }

  return {
    appRoot: input.appRoot,
    devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot),
    dev: input.dev,
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  };
}
