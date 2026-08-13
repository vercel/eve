import { createHash } from "node:crypto";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import type { SkillStoreLocation } from "#runtime/skills/store.js";

/**
 * Describes whether one sandbox needs a prewarmed template and, if so,
 * which inputs must participate in the template key.
 */
export type RuntimeSandboxTemplatePlan =
  | {
      readonly kind: "none";
    }
  | {
      readonly contentHash?: string;
      readonly kind: "workspace-content";
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
  readonly inheritedWorkspaceResourceRoots?: readonly {
    readonly resourceRoot: CompiledWorkspaceResourceRoot;
    readonly skillStoreLocation: SkillStoreLocation;
  }[];
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxTemplatePlan {
  const workspaceResourceRoots = [
    input.workspaceResourceRoot,
    ...(input.inheritedWorkspaceResourceRoots ?? []).map((entry) => entry.resourceRoot),
  ];
  const contentHash = combineWorkspaceResourceContentHashes(
    workspaceResourceRoots,
    input.inheritedWorkspaceResourceRoots ?? [],
  );

  if (input.definition.bootstrap !== undefined) {
    if (input.definition.sourceHash === undefined) {
      throw new Error(
        `Sandbox "${input.definition.logicalPath}" defines bootstrap() but has no compiled sourceHash.`,
      );
    }

    return {
      contentHash,
      kind: "bootstrap",
      revalidationKey: input.definition.revalidationKey,
      sourceHash: input.definition.sourceHash,
    };
  }

  if (
    contentHash === undefined &&
    workspaceResourceRoots.every((root) => root.rootEntries.length === 0)
  ) {
    return { kind: "none" };
  }

  return {
    contentHash,
    kind: "workspace-content",
  };
}

function combineWorkspaceResourceContentHashes(
  roots: readonly CompiledWorkspaceResourceRoot[],
  inherited: readonly {
    readonly skillStoreLocation: SkillStoreLocation;
  }[],
): string | undefined {
  const hashes = [
    ...roots.flatMap((root) =>
      root.contentHash === undefined ? [] : [`${root.logicalPath}:${root.contentHash}`],
    ),
    ...inherited.map(({ skillStoreLocation }) => `agent-home:${skillStoreLocation.home ?? "root"}`),
  ];
  if (hashes.length === 0) return undefined;
  return createHash("sha256").update(hashes.sort().join("\0")).digest("hex");
}
