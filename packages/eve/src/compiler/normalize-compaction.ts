import type { CompiledCompactionDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { normalizeCompactionDefinition } from "#internal/authored-definition/compaction.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export async function compileCompactionDefinition(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledCompactionDefinition> {
  normalizeCompactionDefinition(
    await loadModuleBackedDefinition({
      binding: options.binding,
      kind: "compaction",
      loadNamespace: options.loadNamespace,
      source,
    }),
    `Expected the compaction export "${source.exportName ?? "default"}" from "${source.logicalPath}" to be created with defineCompaction().`,
  );
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
