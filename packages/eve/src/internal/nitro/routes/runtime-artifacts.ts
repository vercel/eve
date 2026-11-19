import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";

export interface DevelopmentNitroArtifactsConfig {
  readonly appRoot: string;
  readonly devRuntimeArtifactsPointerPath: string;
  readonly durableArtifactsReference?: "development-generation";
  readonly kind: "development";
  readonly moduleMapLoaderPath: string;
}

export interface ProductionNitroArtifactsConfig {
  readonly kind: "production";
  readonly sandboxScope: string;
}

export type NitroArtifactsConfig = DevelopmentNitroArtifactsConfig | ProductionNitroArtifactsConfig;

export function resolveNitroCompiledArtifactsSource(
  config: NitroArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  if (config.kind === "development") {
    const runtimeAppRoot =
      readDevelopmentRuntimeArtifactsSnapshotRoot(config.devRuntimeArtifactsPointerPath) ??
      config.appRoot;

    return createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot, {
      durableReference: config.durableArtifactsReference,
      moduleMapLoaderPath: config.moduleMapLoaderPath,
      sandboxAppRoot: config.appRoot,
    });
  }

  if (readBundledCompiledArtifacts() !== null) {
    return createBundledRuntimeCompiledArtifactsSource(config.sandboxScope);
  }

  throw new Error("eve Nitro production requires bundled artifacts.");
}
