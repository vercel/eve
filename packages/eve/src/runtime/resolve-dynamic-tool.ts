import type { CompiledDynamicToolDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { registerDefinitionSource, stampDefinitionKey } from "#public/tool-result-narrowing.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

/**
 * Resolves one compiled dynamic tool entry into a runtime-owned resolver
 * with live event handler functions reattached from the authored module.
 *
 * The resolver's `events` map is validated: each declared event name must
 * map to a function. The handlers are not called here — they run later at
 * the lifecycle point indicated by each event name.
 */
export async function resolveDynamicToolDefinition(
  definition: CompiledDynamicToolDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedDynamicToolResolver> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "dynamic-tool",
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

    const sourceKey = `dynamic-tool-source:${definition.sourceId}`;
    stampDefinitionKey(resolvedRecord, sourceKey);
    registerDefinitionSource(sourceKey, {
      kind: "tool",
      logicalPath: definition.logicalPath,
      name: definition.slug,
    });

    return {
      eventNames: [...definition.eventNames],
      events: handlers as ResolvedDynamicToolResolver["events"],
      exportName: definition.exportName,
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
      `Failed to resolve dynamic tool from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function describe(definition: CompiledDynamicToolDefinition, predicate: string): string {
  return `Expected the dynamic tool export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
