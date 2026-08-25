import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledMemoryDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";

export async function compileMemoryDefinition(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledMemoryDefinition> {
  const definition = normalizeMemoryDefinition(
    await loadModuleBackedDefinition({
      binding: options.binding,
      kind: "memory",
      loadNamespace: options.loadNamespace,
      source,
    }),
    `Expected the memory export "${source.exportName ?? "default"}" from "${source.logicalPath}" to be created with defineMemory().`,
  );
  return {
    description: definition.description,
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    slot: deriveMemorySlot(source.logicalPath),
    sourceId: source.sourceId,
    sourceKind: "module",
    tools: definition.tools,
    visibility: definition.visibility ?? "scope",
  };
}

export function deriveMemorySlot(logicalPath: string): string {
  const extensionless = stripLogicalPathExtension(logicalPath);
  return extensionless === "memory" ? "memory" : extensionless.slice("memory/".length);
}
