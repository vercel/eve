import type { CompiledDynamicToolDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { registerDefinitionSource, stampDefinitionKey } from "#public/tool-result-narrowing.js";
import { isDynamicSentinel, type DynamicSentinel } from "#shared/dynamic-tool-definition.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

type DynamicToolResolverSource = Readonly<
  ModuleSourceRef & {
    readonly extensionNamespace?: string;
    readonly slug: string;
  }
>;

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
    return createResolvedDynamicToolResolver(
      expectDynamicToolValue(resolvedExportValue, definition),
      definition,
      definition.eventNames,
    );
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

/**
 * Resolves an in-memory public `defineDynamic()` value into the runtime shape
 * used by the dynamic-tool lifecycle.
 *
 * Framework-owned dynamic tools use this path because they have no authored
 * module to load from the compiled module map. Their definitions otherwise
 * follow the same public contract as authored dynamic tools.
 */
export function resolveDynamicToolValue(
  value: DynamicSentinel,
  source: DynamicToolResolverSource,
): ResolvedDynamicToolResolver {
  return createResolvedDynamicToolResolver(
    expectDynamicToolValue(value, source),
    source,
    Object.keys(value.events),
  );
}

function createResolvedDynamicToolResolver(
  value: DynamicSentinel,
  source: DynamicToolResolverSource,
  eventNames: readonly string[],
): ResolvedDynamicToolResolver {
  const handlers: Record<string, Function> = {};
  for (const eventName of eventNames) {
    handlers[eventName] = expectFunction(
      value.events[eventName as keyof typeof value.events],
      describe(source, `to provide a handler for event "${eventName}"`),
    );
  }

  const sourceKey = `dynamic-tool-source:${source.sourceId}`;
  stampDefinitionKey(value, sourceKey);
  registerDefinitionSource(sourceKey, {
    kind: "tool",
    logicalPath: source.logicalPath,
    name: source.slug,
  });

  return {
    eventNames: [...eventNames],
    events: handlers as ResolvedDynamicToolResolver["events"],
    exportName: source.exportName,
    extensionNamespace: source.extensionNamespace,
    logicalPath: source.logicalPath,
    slug: source.slug,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}

function expectDynamicToolValue(
  value: unknown,
  definition: DynamicToolResolverSource,
): DynamicSentinel {
  const record = expectObjectRecord(value, describe(definition, "to return an object"));
  if (!isDynamicSentinel(record)) {
    throw new Error(describe(definition, "to be created by defineDynamic()"));
  }
  expectObjectRecord(record.events, describe(definition, "to provide an events object"));
  return record;
}

function describe(definition: DynamicToolResolverSource, predicate: string): string {
  return `Expected the dynamic tool export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
