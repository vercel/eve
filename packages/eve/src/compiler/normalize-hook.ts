import { stripLogicalPathExtension } from "../discover/filesystem.js";
import type { HookSourceRef } from "#discover/manifest.js";
import type { CompiledHookDefinition } from "./manifest.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";

/**
 * Compiles one authored hook module into the manifest entry stored on
 * the compiled agent node.
 *
 * The compiler records event names and verifies that each authored handler is
 * callable. Handler behavior remains runtime-only and is never serialized.
 */
export function compileHookEntry(source: HookSourceRef, value: unknown): CompiledHookDefinition {
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
    slug: stripLogicalPathExtension(source.logicalPath).replace(/^hooks\//, ""),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
