import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";

/**
 * Configuration values needed to resolve the compiled-artifact source for
 * package-owned Nitro routes. Passed explicitly from virtual handlers
 * rather than read from a global runtime configuration store.
 */
export interface NitroArtifactsConfig {
  readonly appRoot?: string;
  readonly dev?: boolean;
  readonly devRuntimeArtifactsPointerPath?: string;
  readonly moduleMapLoaderPath?: string;
}

/**
 * Resolves the compiled-artifact source available to package-owned Nitro
 * routes.
 */
export function resolveNitroCompiledArtifactsSource(
  config: NitroArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  const { appRoot, dev: isDevelopment } = config;

  if (isDevelopment && appRoot !== undefined) {
    if (config.moduleMapLoaderPath === undefined) {
      throw new Error(
        'eve Nitro development routes require "moduleMapLoaderPath" in the artifacts config.',
      );
    }

    const runtimeAppRoot =
      readDevelopmentRuntimeArtifactsSnapshotRoot(config.devRuntimeArtifactsPointerPath) ?? appRoot;

    return createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot, {
      moduleMapLoaderPath: config.moduleMapLoaderPath,
      sandboxAppRoot: appRoot,
    });
  }

  if (readBundledCompiledArtifacts() !== null) {
    return createBundledRuntimeCompiledArtifactsSource();
  }

  if (appRoot !== undefined) {
    return createDiskRuntimeCompiledArtifactsSource(appRoot);
  }

  throw new Error(
    "eve Nitro route requires bundled artifacts or an eve Nitro runtime configuration app root.",
  );
}
