import { deriveMemorySlot } from "#compiler/normalize-memory.js";
import {
  canonicalSourceSlot,
  instantiateProgrammaticTemplate,
  type AgentModuleCandidate,
  type AgentSourceCandidate,
} from "#compiler/source-graph.js";
import { memoryWrapperTemplate } from "#framework/sources/registry.js";

export function createMemoryWrapperCandidates(candidates: readonly AgentSourceCandidate[]) {
  return candidates
    .filter(
      (candidate): candidate is AgentModuleCandidate =>
        candidate.backing.kind !== "resource" &&
        (canonicalSourceSlot(candidate.logicalPath) === "memory" ||
          canonicalSourceSlot(candidate.logicalPath).startsWith("memory/")),
    )
    .map((candidate) => {
      const slot = deriveMemorySlot(candidate.logicalPath);
      return instantiateProgrammaticTemplate({
        anchor: candidate,
        dependencies: { memory: candidate },
        logicalPath: `tools/${slot}.ts`,
        owner: { feature: "memory", kind: "framework" },
        parameters: {
          memoryExportName: candidate.exportName ?? "default",
          memoryLogicalPath: candidate.logicalPath,
          slot,
        },
        template: memoryWrapperTemplate,
      });
    });
}
