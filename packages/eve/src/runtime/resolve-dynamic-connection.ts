import type { CompiledDynamicConnectionDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { isDynamicSentinel } from "#dynamic/definition.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicConnectionResolver } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

/** Reattaches live event handlers for one compiled dynamic connection source. */
export async function resolveDynamicConnectionDefinition(
  definition: CompiledDynamicConnectionDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedDynamicConnectionResolver> {
  try {
    const value = await loadResolvedModuleExport({
      definition,
      kindLabel: "dynamic connection",
      moduleMap,
      nodeId,
    });
    const record = expectObjectRecord(value, describe(definition, "to return an object"));
    if (!isDynamicSentinel(record)) {
      throw new Error(describe(definition, "to be created by defineDynamic()"));
    }
    const events = expectObjectRecord(
      record.events,
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
      events: handlers as ResolvedDynamicConnectionResolver["events"],
      exportName: definition.exportName,
      extensionNamespace: definition.extensionNamespace,
      logicalPath: definition.logicalPath,
      slug: definition.slug,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve dynamic connection from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}

function describe(definition: CompiledDynamicConnectionDefinition, predicate: string): string {
  return `Expected the dynamic connection export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
