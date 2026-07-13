import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";

/**
 * Artifacts config serialized into virtual Nitro handlers so route handlers
 * can resolve compiled artifacts without a global runtime configuration store.
 */
export type NitroArtifactsConfigInput =
  | {
      readonly appRoot: string;
      readonly dev: false;
    }
  | {
      readonly appRoot: string;
      readonly dev: true;
      readonly devRuntimeArtifactsPointerPath: string;
      readonly moduleMapLoaderPath: string;
    };

/** Creates the artifact config baked into development Nitro virtual handlers. */
export function createDevelopmentNitroArtifactsConfig(input: {
  readonly appRoot: string;
}): NitroArtifactsConfigInput {
  return {
    appRoot: input.appRoot,
    devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot),
    dev: true,
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  };
}

/** Creates the artifact config baked into production Nitro virtual handlers. */
export function createProductionNitroArtifactsConfig(input: {
  readonly appRoot: string;
}): NitroArtifactsConfigInput {
  return {
    appRoot: input.appRoot,
    dev: false,
  };
}
