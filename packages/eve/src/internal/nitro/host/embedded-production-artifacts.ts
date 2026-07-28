import type { Nitro } from "nitro/types";

import { stageProductionCompilerArtifacts } from "#internal/application/production-compiler-artifacts.js";

/**
 * Stages eve's non-module compiler resources after Nitro prepares its output
 * and before the embedded build workspace is released on host close.
 */
export function configureEmbeddedProductionArtifacts(input: {
  readonly compilerArtifactsRoot: string;
  readonly nitro: Nitro;
  readonly outputDir: string;
}): void {
  input.nitro.hooks.hook("rollup:before", (_nitro, config) => {
    const stagingPlugin = {
      name: "eve:stage-embedded-production-artifacts",
      async writeBundle() {
        await stageProductionCompilerArtifacts({
          compilerArtifactsRoot: input.compilerArtifactsRoot,
          outputDir: input.outputDir,
        });
      },
    };
    const existingPlugins = Array.isArray(config.plugins)
      ? config.plugins
      : config.plugins === undefined || config.plugins === null
        ? []
        : [config.plugins];
    config.plugins = [...existingPlugins, stagingPlugin];
  });
}
