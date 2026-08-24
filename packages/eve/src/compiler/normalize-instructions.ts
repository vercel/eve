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

interface InstructionsCompileOptions {
  readonly name?: string;
}
type ModuleInstructionsCompileOptions = InstructionsCompileOptions &
  ModuleBackedDefinitionLoadOptions;
import {
  assertResolverOnlyDynamicSentinel,
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  isDynamicSentinel,
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
 * the resulting content is captured into the compiled manifest. There is
 * no per-session re-evaluation at runtime.
 *
 * Module-backed dynamic instructions (exporting `defineDynamic`) are
 * classified and their event names recorded; the resolver runs at
 * runtime.
 */
export function compileInstructionsEntry(
  source: Extract<InstructionsSourceRef, { readonly sourceKind: "module" }>,
  options: ModuleInstructionsCompileOptions,
): Promise<CompiledInstructionsEntry>;
export function compileInstructionsEntry(
  source: Exclude<InstructionsSourceRef, { readonly sourceKind: "module" }>,
  options?: InstructionsCompileOptions,
): Promise<CompiledInstructionsEntry>;
export async function compileInstructionsEntry(
  source: InstructionsSourceRef,
  options: InstructionsCompileOptions | ModuleInstructionsCompileOptions = {},
): Promise<CompiledInstructionsEntry> {
  if (source.sourceKind === "markdown") {
    const definition = normalizeInstructionsDefinition(
      source.definition,
      `Expected the compiled instructions definition at "${source.logicalPath}" to match the public eve shape.`,
    );
    return {
      kind: "instructions",
      definition: {
        name: options.name ?? stripLogicalPathExtension(source.logicalPath),
        logicalPath: source.logicalPath,
        content: definition.content,
        role: definition.role,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
    };
  }

  const moduleOptions = requireModuleOptions(options, source.logicalPath);
  const exportValue = await loadModuleBackedDefinition({
    binding: moduleOptions.binding,
    kind: "instructions",
    moduleLoader: moduleOptions.moduleLoader,
    source,
  });

  if (isDynamicSentinel(exportValue)) {
    assertResolverOnlyDynamicSentinel(
      exportValue,
      `Expected the instructions export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
    );
    const eventNames = Object.keys(exportValue.events);
    const unsupportedEvent = eventNames.find(
      (eventName) => !ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(eventName),
    );
    if (unsupportedEvent !== undefined) {
      throw new Error(
        `Expected the instructions export "${source.exportName ?? "default"}" from "${source.logicalPath}" to use only "session.started" or "turn.started" events. Unsupported event: "${unsupportedEvent}".`,
      );
    }
    const slug =
      options.name ?? stripLogicalPathExtension(source.logicalPath).replace(/^instructions\//, "");
    return {
      kind: "dynamic-instructions",
      definition: {
        eventNames: eventNames as DynamicToolEventName[],
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
      name: options.name ?? stripLogicalPathExtension(source.logicalPath),
      logicalPath: source.logicalPath,
      content: definition.content,
      exportName: source.exportName,
      role: definition.role,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
    },
  };
}

function requireModuleOptions(
  options: InstructionsCompileOptions | ModuleInstructionsCompileOptions,
  logicalPath: string,
): ModuleInstructionsCompileOptions {
  if (!("binding" in options) || options.binding === undefined) {
    throw new Error(`Module-backed instructions "${logicalPath}" requires a selected binding.`);
  }
  return options;
}
