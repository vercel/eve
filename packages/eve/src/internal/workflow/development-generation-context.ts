import { ContextContainer, contextStorage } from "#context/container.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

export interface DevelopmentGenerationContext {
  readonly generationId: string;
  readonly source: RuntimeDiskCompiledArtifactsSource;
}

export function getDevelopmentWorkflowGeneration(): DevelopmentGenerationContext | undefined {
  return contextStorage.getStore()?.developmentWorkflowGeneration;
}

export async function withDevelopmentWorkflowGeneration<T>(
  context: DevelopmentGenerationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer({ developmentWorkflowGeneration: context });
  return await contextStorage.run(ctx, operation);
}
