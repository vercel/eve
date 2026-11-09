import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledDefinition } from "#compiler/manifest.js";
import {
  compiledDefinition,
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { normalizeContentRenderer } from "#internal/authored-definition/content-renderer.js";
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

/** A content renderer, with the media type it draws. */
export async function compileRendererEntry(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledDefinition> {
  const renderer = normalizeContentRenderer(await load("renderer", source, options), source);
  const slug = stripLogicalPathExtension(source.logicalPath).replace(/^renderers\//, "");
  return compiledDefinition("renderer", source, slug, { mediaType: renderer.mediaType });
}

/**
 * The renderers that draw each media type: the agent's own wins over an extension's, and two
 * renderers for one media type at the same level are a build error naming both.
 */
export function selectRenderers(
  definitions: readonly CompiledDefinition[],
): readonly CompiledDefinition[] {
  const byMediaType = new Map<string, CompiledDefinition[]>();
  for (const definition of definitions) {
    if (definition.kind !== "renderer" || definition.mediaType === undefined) continue;
    byMediaType.set(definition.mediaType, [
      ...(byMediaType.get(definition.mediaType) ?? []),
      definition,
    ]);
  }
  const shadowed = new Set<CompiledDefinition>();
  for (const [mediaType, renderers] of byMediaType) {
    if (renderers.length < 2) continue;
    const own = renderers.filter((renderer) => renderer.extensionNamespace === undefined);
    const winners = own.length > 0 ? own : renderers;
    if (winners.length > 1) {
      throw new Error(
        `Content renderers ${winners.map((renderer) => `"${renderer.logicalPath}"`).join(" and ")} both draw "${mediaType}". Remove one, or add a renderer for "${mediaType}" in agent/renderers/ to choose.`,
      );
    }
    for (const renderer of renderers) if (renderer !== winners[0]) shadowed.add(renderer);
  }
  return definitions.filter((definition) => !shadowed.has(definition));
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
  kind: "hook" | "memory" | "renderer",
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<unknown> {
  return loadModuleBackedDefinition({ ...options, kind, source });
}
