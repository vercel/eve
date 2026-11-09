import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledDefinition } from "#compiler/manifest.js";
import {
  compiledDefinition,
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { normalizeHookHandlers } from "#internal/authored-definition/hook.js";
import { memoryMismatch, normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";

/** A hook, with the events it handles. */
export async function compileHookEntry(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledDefinition> {
  const handlers = normalizeHookHandlers(await load("hook", source, options), source);
  const slug = stripLogicalPathExtension(source.logicalPath).replace(/^hooks\//, "");
  return compiledDefinition("hook", source, slug, { eventNames: Object.keys(handlers) });
}

/** A memory, in the slot its path names. */
export async function compileMemoryDefinition(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledDefinition> {
  const memory = normalizeMemoryDefinition(
    await load("memory", source, options),
    memoryMismatch(source),
  );
  return compiledDefinition("memory", source, deriveMemorySlot(source.logicalPath), {
    ...(memory.description !== undefined && { description: memory.description }),
  });
}

export function deriveMemorySlot(logicalPath: string): string {
  const extensionless = stripLogicalPathExtension(logicalPath);
  return extensionless === "memory" ? "memory" : extensionless.slice("memory/".length);
}

function load(
  kind: "hook" | "memory",
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<unknown> {
  return loadModuleBackedDefinition({ ...options, kind, source });
}
