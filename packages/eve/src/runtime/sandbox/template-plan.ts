import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Describes whether one sandbox needs a prewarmed template and, if so,
 * which inputs must participate in the template key.
 */
export type RuntimeSandboxTemplatePlan =
  | {
      readonly kind: "none";
      readonly sourceHash: string;
    }
  | {
      readonly contentHash?: string;
      readonly kind: "workspace-content";
      readonly sourceHash: string;
    }
  | {
      readonly contentHash?: string;
      readonly kind: "bootstrap";
      readonly revalidationKey?: string;
      readonly sourceHash: string;
    };

/**
 * Chooses the template strategy for one resolved sandbox definition.
 */
export function createRuntimeSandboxTemplatePlan(input: {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxTemplatePlan {
  const sourceHash = input.definition.sourceHash;
  if (sourceHash === undefined) {
    throw new Error(`Sandbox "${input.definition.logicalPath}" has no compiled sourceHash.`);
  }
  if (
    input.workspaceResourceRoot.contentHash === undefined &&
    input.workspaceResourceRoot.rootEntries.length > 0
  ) {
    throw new Error(
      `Sandbox "${input.definition.logicalPath}" has managed workspace resources but no compiled contentHash.`,
    );
  }

  if (input.definition.bootstrap !== undefined) {
    return {
      contentHash: input.workspaceResourceRoot.contentHash,
      kind: "bootstrap",
      revalidationKey: input.definition.revalidationKey,
      sourceHash,
    };
  }

  if (
    input.workspaceResourceRoot.contentHash === undefined &&
    input.workspaceResourceRoot.rootEntries.length === 0
  ) {
    return { kind: "none", sourceHash };
  }

  return {
    contentHash: input.workspaceResourceRoot.contentHash,
    kind: "workspace-content",
    sourceHash,
  };
}
