import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledDefinition } from "#compiler/manifest.js";
import {
  compiledDefinition,
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { harnessMismatch, normalizeHarness } from "#internal/authored-definition/harness.js";
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

/**
 * A harness layer: the agent's own `harness.ts` (slug `"harness"`), or a mounted extension's,
 * which composes at `harness/<namespace>.ts` (slug `"<namespace>"`).
 */
export async function compileHarnessDefinition(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledDefinition> {
  normalizeHarness(await load("harness", source, options), harnessMismatch(source));
  return compiledDefinition("harness", source, deriveHarnessSlug(source.logicalPath));
}

export function deriveHarnessSlug(logicalPath: string): string {
  const extensionless = stripLogicalPathExtension(logicalPath);
  return extensionless === "harness" ? "harness" : extensionless.slice("harness/".length);
}

/**
 * Puts the agent's own harness layers ahead of mounted extensions' layers, keeping every other
 * definition where it is and each group in declaration order. Filesystem sources already
 * arrive this way (the agent's own sources, then extensions by namespace); this keeps it true
 * for programmatic sources too, which compose after extensions.
 */
export function orderHarnessDefinitions(
  definitions: readonly CompiledDefinition[],
): CompiledDefinition[] {
  const harnesses = definitions.filter((definition) => definition.kind === "harness");
  const ordered = [
    ...harnesses.filter((definition) => definition.extensionNamespace === undefined),
    ...harnesses.filter((definition) => definition.extensionNamespace !== undefined),
  ];
  let next = 0;
  return definitions.map((definition) =>
    definition.kind === "harness" ? ordered[next++]! : definition,
  );
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
  kind: "harness" | "hook" | "memory",
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<unknown> {
  return loadModuleBackedDefinition({ ...options, kind, source });
}
