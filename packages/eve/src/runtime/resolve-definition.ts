import type {
  CompiledDefinition,
  CompiledScheduleCollectionDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map-schema.js";
import {
  assertDynamicSentinelKeys,
  dynamicEvaluate,
  isDynamicSentinel,
} from "#dynamic/definition.js";
import { normalizeHookHandlers } from "#internal/authored-definition/hook.js";
import { memoryMismatch, normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import type { DynamicSchedulesDefinition } from "#public/schedules/subscription.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { stampScheduleCollectionSource } from "#shared/schedule-collection-definition.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type {
  ResolvedDefinition,
  ResolvedDynamicSource,
  ResolvedScheduleCollection,
} from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

interface Scope {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string | undefined;
  /** The names the agent's tool files take, which an eve feature's tools yield to. */
  readonly toolFiles: ReadonlySet<string>;
}

/** Reattaches the code of a file the agent declares from its module, and checks its shape. */
export async function resolveDefinition(
  definition: CompiledDefinition,
  scope: Scope,
): Promise<ResolvedDefinition> {
  const { eventNames: _events, ...ref } = definition;
  return await resolving(definition, definition.kind, async () => {
    const value = await loadResolvedModuleExport({
      ...scope,
      definition,
      kindLabel: definition.kind,
    });
    switch (definition.kind) {
      case "hook":
        return { ...ref, events: normalizeHookHandlers(value, definition), kind: "hook" };
      case "memory":
        return {
          ...normalizeMemoryDefinition(value, memoryMismatch(definition)),
          ...ref,
          kind: "memory",
          ...(!scope.toolFiles.has(definition.slug) && { offersTools: true as const }),
          slot: definition.slug,
        };
      default:
        return {
          ...ref,
          ...dynamicSource(definition, value, definition.kind),
          kind: definition.kind,
        };
    }
  });
}

/**
 * Reattaches a schedule collection's definition from its module, and stamps it with where it
 * lives, so `schedules()` binds it wherever the agent's code passes it.
 */
export async function resolveScheduleCollection(
  collection: CompiledScheduleCollectionDefinition,
  scope: Scope,
): Promise<ResolvedScheduleCollection & { readonly kind: "schedules" }> {
  return await resolving(collection, "schedule collection", async () => {
    const value = await loadResolvedModuleExport({
      ...scope,
      definition: collection,
      kindLabel: "schedule collection",
    });
    const definition = normalizeScheduleCollectionDefinition(
      value,
      `Expected the schedule collection export from "${collection.logicalPath}" to be created with defineDynamicSchedules().`,
    ) as DynamicSchedulesDefinition<unknown>;
    stampScheduleCollectionSource(value as object, {
      application: collection.application,
      collection: collection.name,
      logicalPath: collection.logicalPath,
      sourceId: collection.sourceId,
    });
    const offersTools =
      definition.tool !== false &&
      !scope.toolFiles.has(scheduleCollectionToolPrefix(collection.name));
    return {
      definition,
      kind: "schedules",
      logicalPath: collection.logicalPath,
      name: collection.name,
      ...(offersTools && { offersTools: true as const }),
      sourceId: collection.sourceId,
      sourceKind: "module",
    };
  });
}

/** Reattaches a compiled `defineDynamic()` export's function from its module. */
export async function resolveDynamicDefinition<T extends ModuleSourceRef>(
  definition: T,
  input: Omit<Scope, "toolFiles"> & { readonly kindLabel: string },
): Promise<T & ResolvedDynamicSource> {
  return await resolving(definition, input.kindLabel, async () => ({
    ...definition,
    ...dynamicSource(
      definition,
      await loadResolvedModuleExport({ ...input, definition }),
      input.kindLabel,
    ),
  }));
}

function dynamicSource(
  definition: ModuleSourceRef,
  value: unknown,
  kind: string,
): Pick<ResolvedDynamicSource, "evaluate"> {
  const subject = `the ${kind} export "${definition.exportName ?? "default"}" from "${definition.logicalPath}"`;
  if (!isDynamicSentinel(value)) {
    throw new Error(`Expected ${subject} to be created by defineDynamic().`);
  }
  assertDynamicSentinelKeys(value, `The ${subject.slice("the ".length)}:`);
  return {
    evaluate: dynamicEvaluate(value) as ResolvedDynamicSource["evaluate"],
  };
}

async function resolving<T>(
  definition: ModuleSourceRef,
  kind: string,
  resolve: () => Promise<T>,
): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve ${kind} from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}
