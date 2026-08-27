import type { CompiledDynamicSkillDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";

/**
 * Resolves one compiled dynamic skill entry into a runtime-owned resolver
 * with live event handler functions reattached from the authored module.
 */
export async function resolveDynamicSkillDefinition(
  definition: CompiledDynamicSkillDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedDynamicSkillResolver> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "dynamic-skill",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      describe(definition, "to return an object"),
    );

    const events = expectObjectRecord(
      resolvedRecord.events,
      describe(definition, "to provide an events object"),
    );

    const handlers: Record<string, Function> = {};
    for (const eventName of definition.eventNames) {
      handlers[eventName] = expectFunction(
        events[eventName],
        describe(definition, `to provide a handler for event "${eventName}"`),
      );
    }

    return {
      eventNames: [...definition.eventNames],
      events: handlers as ResolvedDynamicSkillResolver["events"],
      exportName: definition.exportName,
      extensionNamespace: definition.extensionNamespace,
      logicalPath: definition.logicalPath,
      slug: definition.slug,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to resolve dynamic skill from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function describe(definition: CompiledDynamicSkillDefinition, predicate: string): string {
  return `Expected the dynamic skill export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
