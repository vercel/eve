import type { CompiledScheduleCollectionDefinition } from "#compiler/manifest.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
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
  const existing = compiled.find((entry) => entry.name === collection.name);
  if (existing !== undefined) {
    throw new Error(
      `Schedule collections "${existing.logicalPath}" and "${collection.logicalPath}" both resolve to the name "${collection.name}". Set a different "id" on one of them, or rename its file.`,
    );
  }
}
