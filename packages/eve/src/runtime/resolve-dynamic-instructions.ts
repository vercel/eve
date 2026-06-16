import type { CompiledDynamicInstructionsDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";

export async function resolveDynamicInstructionsDefinition(
  definition: CompiledDynamicInstructionsDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedDynamicInstructionsResolver> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "dynamic-instructions",
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
      events: handlers as ResolvedDynamicInstructionsResolver["events"],
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
      `Failed to resolve dynamic instructions from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function describe(definition: CompiledDynamicInstructionsDefinition, predicate: string): string {
  return `Expected the dynamic instructions export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
