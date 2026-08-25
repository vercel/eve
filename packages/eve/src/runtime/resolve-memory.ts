import type { CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

export async function resolveMemoryDefinition(
  compiled: CompiledMemoryDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedMemoryDefinition> {
  try {
    const value = await loadResolvedModuleExport({
      definition: compiled,
      kindLabel: "memory",
      moduleMap,
      nodeId,
    });
    const definition = normalizeMemoryDefinition(
      value,
      `Expected the memory export "${compiled.exportName ?? "default"}" from "${compiled.logicalPath}" to be created with defineMemory().`,
    );
    return {
      ...definition,
      description: compiled.description,
      exportName: compiled.exportName,
      logicalPath: compiled.logicalPath,
      slot: compiled.slot,
      sourceId: compiled.sourceId,
      sourceKind: "module",
      tools: compiled.tools,
      visibility: compiled.visibility,
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve memory from "${compiled.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: compiled.logicalPath, sourceId: compiled.sourceId },
    );
  }
}
