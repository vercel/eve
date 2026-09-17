import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

export interface RuntimeSandboxTemplatePlan {
  readonly contentHash?: string;
  readonly revisionHash: string;
}

export function createRuntimeSandboxTemplatePlan(input: {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxTemplatePlan {
  return {
    contentHash: input.workspaceResourceRoot.contentHash,
    revisionHash: input.definition.revisionHash,
  };
}
