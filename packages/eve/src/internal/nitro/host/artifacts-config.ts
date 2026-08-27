import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";
import type {
  DevelopmentNitroArtifactsConfig,
  ProductionNitroArtifactsConfig,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";

/**
 * Runtime-artifacts wiring for the dev server: routes read compiled
 * artifacts from the authored app root via the snapshot pointer so hot
 * reload can swap them.
 */
export function createDevelopmentNitroArtifactsConfig(input: {
  readonly appRoot: string;
  readonly configuredWorld?: AgentWorkflowWorldDefinition;
}): DevelopmentNitroArtifactsConfig {
  return {
    appRoot: input.appRoot,
    devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot),
    // Only parent-World deliveries install the generation context that a
    // logical durable selector needs; a custom World's payloads must pin
    // their exact snapshot instead.
    durableArtifactsReference: usesParentDevelopmentWorkflowWorld(input.configuredWorld)
      ? "development-generation"
      : undefined,
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
