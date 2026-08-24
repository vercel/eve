import { stripLogicalPathExtension } from "../discover/filesystem.js";
import type { HookSourceRef } from "#discover/manifest.js";
import type { CompiledHookDefinition } from "./manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";

/**
 * Compiles one authored hook module into the manifest entry stored on
 * the compiled agent node.
 *
 * Event names and callable handlers are validated while the source is already
 * loaded for compilation. Handler implementations remain in the module map.
 */
export async function compileHookEntry(
  source: HookSourceRef,
  options: ModuleBackedDefinitionLoadOptions & { readonly slug?: string },
): Promise<CompiledHookDefinition> {
  const value = await loadModuleBackedDefinition({
    binding: options.binding,
    kind: "hook",
    moduleLoader: options.moduleLoader,
    source,
  });
  const message = `Expected the hook export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`;
  const definition = expectObjectRecord(value, message);
  expectOnlyKnownKeys(definition, ["events"], message);
  const events =
    definition.events === undefined ? {} : expectObjectRecord(definition.events, message);
  const eventNames = Object.entries(events)
    .filter(([, handler]) => handler !== undefined)
    .map(([eventName, handler]) => {
      expectFunction(handler, message);
      return eventName;
    })
    .sort();

  return {
    eventNames,
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    slug: options.slug ?? stripLogicalPathExtension(source.logicalPath).replace(/^hooks\//, ""),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
