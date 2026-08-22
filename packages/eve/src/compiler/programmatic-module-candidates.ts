import type { AgentModuleCandidate } from "#compiler/agent-module-candidate.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";

export function createProgrammaticModuleCandidates(input: {
  readonly isRoot: boolean;
  readonly nodeId: string;
  readonly registry: AgentSourceRegistry;
}): AgentModuleCandidate[] {
  return input.registry.registrations.flatMap((registration) => {
    if (registration.applyTo === "root" && !input.isRoot) return [];

    return registration.source.modules.map((module) => ({
      backing: {
        kind: "programmatic" as const,
        moduleId: module.logicalPath,
        registryId: registration.source.id,
      },
      layer: "framework-default" as const,
      logicalPath: module.logicalPath,
      nodeId: input.nodeId,
      owner: {
        feature: registration.source.id,
        kind: "framework" as const,
      },
      sourceId: `${registration.source.id}:${module.logicalPath}`,
    }));
  });
}
