import type { CompiledHookDefinition } from "../compiler/manifest.js";
import type { CompiledModuleMap } from "../compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "../internal/authored-module.js";
import type { StreamEventHook } from "../public/definitions/hook.js";
import { toErrorMessage } from "../shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "./resolve-helpers.js";
import type { ResolvedHookDefinition } from "./types.js";

/**
 * Resolves one compiled authored hook into a runtime-owned definition
 * with live handlers reattached from the authored module.
 *
 * The authored shape is `{ events?: { ... } }`.
 * Each declared handler must be a function. Any other shape raises a
 * {@link ResolveAgentError} so typos surface at resolve time instead of
 * at first dispatch call.
 */
export async function resolveHookDefinition(
  definition: CompiledHookDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedHookDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "hook",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      describe(definition, "to return an object"),
    );

    const events: Record<string, StreamEventHook<unknown>> = {};

    const eventsRaw = resolvedRecord.events;
    if (eventsRaw !== undefined) {
      const eventsRecord = expectObjectRecord(
        eventsRaw,
        describe(definition, "to expose `events` as an object"),
      );
      for (const [key, value] of Object.entries(eventsRecord)) {
        if (value === undefined) continue;
        const handler = expectFunction(
          value,
          describe(definition, `to provide a function for "events.${key}"`),
        );
        events[key] = handler as StreamEventHook<unknown>;
      }
    }

    return {
      events,
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
      `Failed to attach hook handlers from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function describe(definition: CompiledHookDefinition, predicate: string): string {
  return `Expected the hook export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
