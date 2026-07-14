import { getDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

interface DevelopmentCompiledArtifactsSelector {
  readonly kind: "development";
}

export type DurableCompiledArtifactsSource =
  | RuntimeCompiledArtifactsSource
  | DevelopmentCompiledArtifactsSelector;

export function serializeDurableCompiledArtifactsSource(
  source: RuntimeCompiledArtifactsSource,
): DurableCompiledArtifactsSource {
  if (source.kind === "disk" && isEveDevEnvironment()) {
    return { kind: "development" };
  }
  return source;
}

export function resolveDurableCompiledArtifactsSource(
  source: DurableCompiledArtifactsSource,
): RuntimeCompiledArtifactsSource {
  if (source.kind !== "development") {
    return source;
  }
  const generation = getDevelopmentWorkflowGeneration();
  if (generation === undefined) {
    throw new Error(
      "A development Workflow generation selector was resumed outside a generation-bound delivery.",
    );
  }
  return generation.source;
}
