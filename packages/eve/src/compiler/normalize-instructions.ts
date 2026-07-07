import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { InstructionsSourceRef } from "#discover/manifest.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type {
  CompiledDynamicInstructionsDefinition,
  CompiledInstructionsDefinition,
} from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import {
  isDynamicSentinel,
  rejectDynamicSentinelFallback,
  type DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";

/**
 * Compiled instructions entry produced from one authored `instructions/*`
 * file or flat `instructions.{md,ts,...}`.
 *
 * Either a static instructions definition or a dynamic resolver that
 * produces model messages at runtime.
 */
export type CompiledInstructionsEntry =
  | { readonly kind: "instructions"; readonly definition: CompiledInstructionsDefinition }
  | {
      readonly kind: "dynamic-instructions";
      readonly definition: CompiledDynamicInstructionsDefinition;
    };

/**
 * Compiles one authored instructions prompt source (markdown or
 * module-backed `defineInstructions`) into the normalized shape consumed
 * by the runtime.
 *
 * Module-backed static instructions sources execute once at build time —
 * the resulting markdown is captured into the compiled manifest. There is
 * no per-session re-evaluation at runtime.
 *
 * Module-backed dynamic instructions (exporting `defineDynamic`) are
 * classified and their event names recorded; the resolver runs at
 * runtime.
 */
export async function compileInstructionsEntry(
  agentRoot: string,
  source: InstructionsSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
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
        markdown: definition.markdown,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
    };
  }

  const exportValue = await loadModuleBackedDefinition({
    agentRoot,
    externalDependencies: options.externalDependencies,
    kind: "instructions",
    source,
  });

  if (isDynamicSentinel(exportValue)) {
    rejectDynamicSentinelFallback(
      exportValue,
      `Expected the instructions export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
    );
    const slug = stripLogicalPathExtension(source.logicalPath).replace(/^instructions\//, "");
    return {
      kind: "dynamic-instructions",
      definition: {
        eventNames: Object.keys(exportValue.events) as DynamicToolEventName[],
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        slug,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
    };
  }

  const definition = normalizeInstructionsDefinition(
    exportValue,
    `Expected the instructions export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
    kind: "instructions",
    definition: {
      name: stripLogicalPathExtension(source.logicalPath),
      logicalPath: source.logicalPath,
      markdown: definition.markdown,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
    },
  };
}

/**
 * @deprecated Use {@link compileInstructionsEntry} instead. Kept for
 * backwards compatibility with callers that pass a single source.
 */
export async function compileInstructions(
  agentRoot: string,
  source: InstructionsSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledInstructionsDefinition> {
  const entry = await compileInstructionsEntry(agentRoot, source, options);
  if (entry.kind === "dynamic-instructions") {
    throw new Error(
      `Expected static instructions from "${source.logicalPath}" but got a dynamic resolver. Use compileInstructionsEntry instead.`,
    );
  }
  return entry.definition;
}
