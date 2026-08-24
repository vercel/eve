import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { HookSourceRef } from "#discover/manifest.js";
import type { CompiledHookDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";

/** Compiles and validates one selected hook while preserving its exact subscriptions. */
export async function compileHookEntry(
  source: HookSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledHookDefinition> {
  const loaded = expectObjectRecord(
    await loadModuleBackedDefinition({
      binding: options.binding,
      kind: "hook",
      registries: options.registries,
      source,
    }),
    `Expected the hook export "${source.exportName ?? "default"}" from "${source.logicalPath}" to return an object.`,
  );
  const events =
    loaded.events === undefined
      ? {}
      : expectObjectRecord(
          loaded.events,
          `Expected the hook export "${source.exportName ?? "default"}" from "${source.logicalPath}" to expose events as an object.`,
        );
  const eventNames = Object.entries(events).flatMap(([name, handler]) => {
    if (handler === undefined) return [];
    expectFunction(
      handler,
      `Expected the hook export "${source.exportName ?? "default"}" from "${source.logicalPath}" to provide a function for events.${name}.`,
    );
    return [name];
  });

  return {
    eventNames,
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    slug: stripLogicalPathExtension(source.logicalPath).replace(/^hooks\//, ""),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
