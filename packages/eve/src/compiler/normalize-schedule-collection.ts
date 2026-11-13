import type {
  CompiledScheduleCollectionDefinition,
  CompiledScheduleDefinition,
} from "#compiler/manifest.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import { scheduleCollectionToolSlot } from "#shared/schedule-collection-tools.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { namedScopeCollectionName } from "#runtime/schedules/named-scope.js";

/**
 * The collections one definition stores schedules in: itself, or one for each named scope.
 */
export function compileScheduleCollectionDefinitions(
  source: ScheduleSourceRef,
  value: unknown,
  application: string,
): CompiledScheduleCollectionDefinition[] {
  if (source.sourceKind !== "module") {
    throw new Error(`Schedule collections must be authored as modules: "${source.logicalPath}".`);
  }
  const definition = normalizeScheduleCollectionDefinition(
    value,
    `Expected the schedule collection export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  const name =
    definition.id ?? stripLogicalPathExtension(source.logicalPath).replace(/^schedules\//u, "");
  const compile = (
    collection: string,
    description: string | undefined,
  ): CompiledScheduleCollectionDefinition => {
    const compiled: CompiledScheduleCollectionDefinition = {
      application,
      logicalPath: source.logicalPath,
      name: collection,
      providerKind: definition.provider.kind,
      sourceId: source.sourceId,
      sourceKind: "module",
    };
    if (description !== undefined) compiled.description = description;
    if (definition.tool !== undefined) compiled.tools = definition.tool;
    return compiled;
  };
  if (definition.scopes === undefined) return [compile(name, definition.description)];
  return Object.entries(definition.scopes).map(([scopeName, scope]) => ({
    ...compile(
      namedScopeCollectionName(name, scopeName, scope),
      (typeof scope === "function" ? undefined : scope.description) ?? definition.description,
    ),
    namedScope: { definition: name, name: scopeName },
  }));
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
    // The named scopes of one definition share its tools; anything else may not.
    const toolSlot = scheduleCollectionToolSlot(collection);
    if (
      scheduleCollectionToolSlot(existing) === toolSlot &&
      (collection.namedScope === undefined ||
        existing.namedScope?.definition !== collection.namedScope.definition ||
        existing.sourceId !== collection.sourceId)
    ) {
      throw new Error(
        `Schedule collections "${existing.logicalPath}" ("${existing.name}") and "${collection.logicalPath}" ("${collection.name}") both name their tools "${toolSlot}". Set a different "id" on one of them, or rename its file.`,
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
