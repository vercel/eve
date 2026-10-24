import type { CompiledCompactionDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeCompactionDefinition } from "#internal/authored-definition/compaction.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedCompactionDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

export async function resolveCompactionDefinition(
  compiled: CompiledCompactionDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedCompactionDefinition> {
  try {
    const value = await loadResolvedModuleExport({
      definition: compiled,
      kindLabel: "compaction",
      moduleMap,
      nodeId,
    });
    const strategy = normalizeCompactionDefinition(
      value,
      `Expected the compaction export "${compiled.exportName ?? "default"}" from "${compiled.logicalPath}" to be created with defineCompaction().`,
    );
    return {
      exportName: compiled.exportName,
      logicalPath: compiled.logicalPath,
      sourceId: compiled.sourceId,
      sourceKind: "module",
      strategy,
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve compaction from "${compiled.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: compiled.logicalPath, sourceId: compiled.sourceId },
    );
  }
}
