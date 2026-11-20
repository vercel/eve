import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { InstructionsSourceRef } from "#discover/manifest.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { CompiledDefinition, CompiledInstructionsDefinition } from "#compiler/manifest.js";
import {
  dynamicDefinition,
  loadModuleBackedDefinition,
  requireModuleBackedDefinitionLoadOptions,
  type SourceDefinitionCompileOptions,
} from "#compiler/normalize-helpers.js";

type CompiledInstructionsEntry =
  | { readonly kind: "instructions"; readonly definition: CompiledInstructionsDefinition }
  | { readonly kind: "dynamic"; readonly definition: CompiledDefinition };

export async function compileInstructionsEntry(
  _agentRoot: string,
  source: InstructionsSourceRef,
  options: SourceDefinitionCompileOptions,
): Promise<CompiledInstructionsEntry> {
  if (source.sourceKind === "markdown") {
    const definition = normalizeInstructionsDefinition(
      source.definition,
      `Expected the compiled instructions definition at "${source.logicalPath}" to match the public eve shape.`,
    );
    return {
      kind: "instructions",
      definition: {
        name: stripLogicalPathExtension(source.logicalPath),
        logicalPath: source.logicalPath,
        owner: options.owner,
        content: definition.content,
        role: definition.role,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
    };
  }

  const loadOptions = requireModuleBackedDefinitionLoadOptions(options, source.logicalPath);
  const exportValue = await loadModuleBackedDefinition({
    binding: loadOptions.binding,
    kind: "instructions",
    loadNamespace: loadOptions.loadNamespace,
    source,
  });

  const slug = stripLogicalPathExtension(source.logicalPath).replace(/^instructions\//, "");
  const dynamic = dynamicDefinition("instructions", source, exportValue, slug);
  if (dynamic !== undefined) return { definition: dynamic, kind: "dynamic" };

  const definition = normalizeInstructionsDefinition(
    exportValue,
    `Expected the instructions export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
    kind: "instructions",
    definition: {
      name: stripLogicalPathExtension(source.logicalPath),
      logicalPath: source.logicalPath,
      content: definition.content,
      role: definition.role,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
    },
  };
}
