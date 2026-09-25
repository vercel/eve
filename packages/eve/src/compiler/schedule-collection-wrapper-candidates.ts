import {
  canonicalSourceSlot,
  instantiateProgrammaticTemplate,
  type AgentModuleCandidate,
  type AgentSourceCandidate,
} from "#compiler/source-graph.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { scheduleCollectionWrapperTemplate } from "#framework/sources/registry.js";

export function createScheduleCollectionWrapperCandidates(
  candidates: readonly AgentSourceCandidate[],
  application: string,
) {
  return candidates
    .filter(
      (candidate): candidate is AgentModuleCandidate =>
        candidate.backing.kind !== "resource" &&
        canonicalSourceSlot(candidate.logicalPath).startsWith("schedules/"),
    )
    .map((candidate) => {
      const collection = stripLogicalPathExtension(candidate.logicalPath).slice(
        "schedules/".length,
      );
      return instantiateProgrammaticTemplate({
        anchor: candidate,
        dependencies: { collection: candidate },
        logicalPath: `tools/schedule__${collection}.ts`,
        owner: { feature: "schedule-collection", kind: "framework" },
        parameters: {
          application,
          collection,
          collectionExportName: candidate.exportName ?? "default",
          collectionLogicalPath: candidate.logicalPath,
        },
        template: scheduleCollectionWrapperTemplate,
      });
    });
}
