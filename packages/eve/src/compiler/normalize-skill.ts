import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { SkillSourceRef } from "#discover/manifest.js";
import type { SkillPackageSourceRef } from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import { normalizeSkillDefinition } from "#internal/authored-definition/core.js";
import type {
  CompiledDynamicSkillDefinition,
  CompiledSkillDefinition,
} from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";

interface SkillCompileOptions {
  readonly name?: string;
}
type ModuleSkillCompileOptions = SkillCompileOptions & ModuleBackedDefinitionLoadOptions;
import {
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  assertResolverOnlyDynamicSentinel,
  isDynamicSentinel,
  type DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";

/**
 * Compiled skill entry produced from one authored `skills/*` file.
 *
 * Either a real skill definition or a dynamic skill resolver that
 * produces skills at runtime.
 */
export type CompiledSkillEntry =
  | { readonly kind: "skill"; readonly definition: CompiledSkillDefinition }
  | { readonly kind: "dynamic-skill"; readonly definition: CompiledDynamicSkillDefinition };

/**
 * Compiles one authored skill source (markdown, module, or skill
 * package directory) into the normalized shape stored on the compiled
 * agent manifest.
 */
export function compileSkillSource(
  source: Extract<SkillSourceRef, { readonly sourceKind: "module" }>,
  options: ModuleSkillCompileOptions,
): Promise<CompiledSkillEntry>;
export function compileSkillSource(
  source: Exclude<SkillSourceRef, { readonly sourceKind: "module" }>,
  options?: SkillCompileOptions,
): Promise<CompiledSkillEntry>;
export async function compileSkillSource(
  source: SkillSourceRef,
  options: SkillCompileOptions | ModuleSkillCompileOptions = {},
): Promise<CompiledSkillEntry> {
  if (source.sourceKind === "skill-package") {
    return { kind: "skill", definition: compileSkillPackageSource(source, options.name) };
  }

  if (source.sourceKind === "markdown") {
    const definition = normalizeSkillDefinition(
      source.definition,
      `Expected the compiled skill definition at "${source.logicalPath}" to match the public eve shape.`,
    );
    return {
      kind: "skill",
      definition: withOptionalSkillFiles(
        {
          description: definition.description,
          license: definition.license,
          logicalPath: source.logicalPath,
          markdown: definition.markdown,
          metadata:
            definition.metadata === undefined
              ? undefined
              : {
                  ...definition.metadata,
                },
          name:
            options.name ?? stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
        },
        definition.files,
      ),
    };
  }

  // Module-backed skill — load the export and check for DynamicSentinel.
  const moduleOptions = requireModuleOptions(options, source.logicalPath);
  const exportValue = await loadModuleBackedDefinition({
    binding: moduleOptions.binding,
    kind: "skill",
    moduleLoader: moduleOptions.moduleLoader,
    source,
  });

  if (isDynamicSentinel(exportValue)) {
    assertResolverOnlyDynamicSentinel(
      exportValue,
      `Expected the skill export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
    );
    const eventNames = Object.keys(exportValue.events);
    const unsupportedEvent = eventNames.find(
      (eventName) => !ALLOWED_DYNAMIC_SKILL_EVENTS.has(eventName),
    );
    if (unsupportedEvent !== undefined) {
      throw new Error(
        `Expected the skill export "${source.exportName ?? "default"}" from "${source.logicalPath}" to use only session or turn events. Unsupported event: "${unsupportedEvent}".`,
      );
    }
    const slug =
      options.name ?? stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, "");
    return {
      kind: "dynamic-skill",
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

  const definition = normalizeSkillDefinition(
    exportValue,
    `Expected the skill export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
    kind: "skill",
    definition: withOptionalSkillFiles(
      {
        description: definition.description,
        exportName: source.exportName,
        license: definition.license,
        logicalPath: source.logicalPath,
        markdown: definition.markdown,
        metadata:
          definition.metadata === undefined
            ? undefined
            : {
                ...definition.metadata,
              },
        name:
          options.name ?? stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
      definition.files,
    ),
  };
}

function withOptionalSkillFiles(
  definition: CompiledSkillDefinition,
  files: CompiledSkillDefinition["files"],
): CompiledSkillDefinition {
  return files === undefined ? definition : { ...definition, files };
}

function requireModuleOptions(
  options: SkillCompileOptions | ModuleSkillCompileOptions,
  logicalPath: string,
): ModuleSkillCompileOptions {
  if (!("binding" in options) || options.binding === undefined) {
    throw new Error(`Module-backed skill "${logicalPath}" requires a selected binding.`);
  }
  return options;
}

function compileSkillPackageSource(
  source: NamedSkillDefinition & SkillPackageSourceRef,
  name?: string,
): CompiledSkillDefinition {
  return {
    assetsPath: source.assetsPath,
    description: source.description,
    license: source.license,
    logicalPath: source.logicalPath,
    markdown: source.markdown,
    metadata:
      source.metadata === undefined
        ? undefined
        : {
            ...source.metadata,
          },
    name: name ?? source.name,
    referencesPath: source.referencesPath,
    rootPath: source.rootPath,
    scriptsPath: source.scriptsPath,
    skillId: source.skillId,
    skillFilePath: source.skillFilePath,
    sourceId: source.sourceId,
    sourceKind: "skill-package",
  };
}
