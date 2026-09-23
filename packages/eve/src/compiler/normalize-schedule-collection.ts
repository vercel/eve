import type { CompiledScheduleCollectionDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  requireModuleBackedDefinitionLoadOptions,
  type SourceDefinitionCompileOptions,
} from "#compiler/normalize-helpers.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";
import { serializeInputSchema } from "#tools/schema.js";

export async function compileScheduleCollectionCandidate(
  source: ScheduleSourceRef,
  options: SourceDefinitionCompileOptions,
): Promise<CompiledScheduleCollectionDefinition | null> {
  if (source.sourceKind !== "module") return null;
  const value = await loadModuleBackedDefinition({
    ...requireModuleBackedDefinitionLoadOptions(options, source.logicalPath),
    kind: "schedule collection",
    source,
  });
  if (!isScheduleCollectionDefinition(value)) return null;
  const definition = normalizeScheduleCollectionDefinition(
    value,
    `Expected the schedule collection export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  const compiled: CompiledScheduleCollectionDefinition = {
    inputSchema: serializeInputSchema(definition.inputSchema),
    logicalPath: source.logicalPath,
    name: stripLogicalPathExtension(source.logicalPath).replace(/^schedules\//u, ""),
    providerKind: definition.provider.kind,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
  if (definition.description !== undefined) compiled.description = definition.description;
  if (definition.tools !== undefined) compiled.tools = definition.tools;
  return compiled;
}
