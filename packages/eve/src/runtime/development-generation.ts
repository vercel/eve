import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

interface DevelopmentGenerationContext {
  readonly generationId: string;
  readonly source: RuntimeDiskCompiledArtifactsSource;
}

const DevelopmentGenerationKey = new ContextKey<DevelopmentGenerationContext>(
  "eve.internal.developmentGeneration",
);

export function getDevelopmentWorkflowGeneration(): DevelopmentGenerationContext | undefined {
  return contextStorage.getStore()?.get(DevelopmentGenerationKey);
}

export async function withDevelopmentWorkflowGeneration<T>(
  context: DevelopmentGenerationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(DevelopmentGenerationKey, context);
  return await contextStorage.run(ctx, operation);
}
