import type { CompiledModuleMap } from "#compiler/module-map.js";
import { assertResolverForm, isDynamicSentinel } from "#dynamic/definition.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedReactionSource } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Reattaches a compiled `defineDynamic()` export's `select` and `resolve` from its module. */
export async function resolveDynamicDefinition<T extends ModuleSourceRef>(
  definition: T,
  input: {
    readonly kindLabel: string;
    readonly moduleMap: CompiledModuleMap;
    readonly nodeId: string | undefined;
  },
): Promise<T & ResolvedReactionSource> {
  const describe = (predicate: string) =>
    `Expected the ${input.kindLabel} export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
  try {
    const value = await loadResolvedModuleExport({
      definition,
      kindLabel: input.kindLabel,
      moduleMap: input.moduleMap,
      nodeId: input.nodeId,
    });
    if (!isDynamicSentinel(value)) throw new Error(describe("to be created by defineDynamic()"));
    assertResolverForm(
      value,
      `The ${input.kindLabel} export "${definition.exportName ?? "default"}" from "${definition.logicalPath}"`,
      { events: false },
    );
    return {
      ...definition,
      resolve: value.resolve as ResolvedReactionSource["resolve"],
      select: value.select as ResolvedReactionSource["select"],
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve ${input.kindLabel} from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}
