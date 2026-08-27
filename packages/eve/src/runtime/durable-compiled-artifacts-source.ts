import { getDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
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
  // Only sources whose deliveries install a generation context may store
  // the logical selector; everything else (custom Worlds in dev, production
  // disk sources) stores its exact location so replay needs no eve-specific
  // delivery context.
  if (source.kind === "disk" && source.durableReference === "development-generation") {
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
