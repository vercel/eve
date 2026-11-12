import type {
  CompiledScheduleCollectionDefinition,
  CompiledScheduleDefinition,
} from "#compiler/manifest.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";

export function compileScheduleCollectionDefinition(
  source: ScheduleSourceRef,
  value: unknown,
  application: string,
): CompiledScheduleCollectionDefinition {
  if (source.sourceKind !== "module") {
    throw new Error(`Schedule collections must be authored as modules: "${source.logicalPath}".`);
  }
  const definition = normalizeScheduleCollectionDefinition(
    value,
    `Expected the schedule collection export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  const compiled: CompiledScheduleCollectionDefinition = {
    application,
    logicalPath: source.logicalPath,
    name:
      definition.id ?? stripLogicalPathExtension(source.logicalPath).replace(/^schedules\//u, ""),
    providerKind: definition.provider.kind,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
  if (definition.description !== undefined) compiled.description = definition.description;
  if (definition.tool !== undefined) compiled.tools = definition.tool;
  return compiled;
}

/** Throws when two collections would share stored schedules, tools, and deliveries. */
export function assertScheduleCollectionNameAvailable(
  compiled: readonly CompiledScheduleCollectionDefinition[],
  collection: CompiledScheduleCollectionDefinition,
): void {
  for (const existing of compiled) {
    if (existing.name === collection.name) {
      throw new Error(
        `Schedule collections "${existing.logicalPath}" and "${collection.logicalPath}" both resolve to the name "${collection.name}". Set a different "id" on one of them, or rename its file.`,
      );
    }
    const toolPrefix = scheduleCollectionToolPrefix(collection.name);
    if (scheduleCollectionToolPrefix(existing.name) === toolPrefix) {
      throw new Error(
        `Schedule collections "${existing.logicalPath}" ("${existing.name}") and "${collection.logicalPath}" ("${collection.name}") both name their tools "${toolPrefix}". Set a different "id" on one of them, or rename its file.`,
      );
    }
  }
}

/** Throws when a collection and a static schedule share a name, which `session.schedule.definition` reports for both. */
export function assertScheduleCollectionNamesDistinctFromSchedules(
  collections: readonly CompiledScheduleCollectionDefinition[],
  schedules: readonly CompiledScheduleDefinition[],
): void {
  for (const collection of collections) {
    const schedule = schedules.find((candidate) => candidate.name === collection.name);
    if (schedule === undefined) continue;
    throw new Error(
      `Schedule collection "${collection.logicalPath}" and schedule "${schedule.logicalPath}" both resolve to the name "${collection.name}". Set a different "id" on the collection, or rename one of the files.`,
    );
  }
}
