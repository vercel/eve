import { stripLogicalPathExtension } from "../discover/filesystem.js";
import type { HookSourceRef } from "#discover/manifest.js";
import type { CompiledHookDefinition } from "./manifest.js";

/**
 * Compiles one authored hook module into the manifest entry stored on
 * the compiled agent node.
 *
 * Hook event handlers are arbitrary functions and cannot be statically
 * validated at compile time — the normalization step only derives the
 * path-relative slug used for diagnostics and ordering. Per-handler
 * validation lives in the runtime resolver.
 */
export function compileHookEntry(source: HookSourceRef): CompiledHookDefinition {
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    slug: stripLogicalPathExtension(source.logicalPath).replace(/^hooks\//, ""),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
