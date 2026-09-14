import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

type EnvironmentGeneration = { readonly environmentHash: string };

export type RuntimeSandboxTemplatePlan =
  | (EnvironmentGeneration & { readonly contentHash?: undefined; readonly kind: "none" })
  | (EnvironmentGeneration & { readonly contentHash?: string; readonly kind: "workspace-content" })
  | (EnvironmentGeneration & {
      readonly contentHash?: string;
      readonly dockerfileHash?: string;
      readonly kind: "prepared";
    })
  | (EnvironmentGeneration & {
      readonly contentHash?: string;
      readonly dockerfileHash: string;
      readonly kind: "dockerfile";
    });

export function createRuntimeSandboxTemplatePlan(input: {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxTemplatePlan {
  const environmentHash = input.definition.sourceHash;
  if (environmentHash === undefined)
    throw new Error(`Sandbox "${input.definition.logicalPath}" has no source hash.`);
  const contentHash = input.workspaceResourceRoot.contentHash;
  if (input.definition.kind === "independent" && input.definition.environment.kind === "prepared") {
    return {
      contentHash,
      dockerfileHash: input.definition.dockerfileHash,
      environmentHash,
      kind: "prepared",
    };
  }
  if (
    input.definition.kind === "independent" &&
    input.definition.environment.kind === "dockerfile"
  ) {
    if (input.definition.dockerfileHash === undefined)
      throw new Error(
        `Sandbox "${input.definition.logicalPath}" uses a Dockerfile environment, but no compiled Dockerfile hash is available.`,
      );
    return {
      contentHash,
      dockerfileHash: input.definition.dockerfileHash,
      environmentHash,
      kind: "dockerfile",
    };
  }
  if (contentHash === undefined && input.workspaceResourceRoot.rootEntries.length === 0)
    return { environmentHash, kind: "none" };
  return { contentHash, environmentHash, kind: "workspace-content" };
}
