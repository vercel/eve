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
import {
  isDynamicSentinel,
  rejectDynamicSentinelFallback,
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
export async function compileSkillSource(
  agentRoot: string,
  source: SkillSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledSkillEntry> {
  if (source.sourceKind === "skill-package") {
    return { kind: "skill", definition: compileSkillPackageSource(source) };
  }

  if (source.sourceKind === "markdown") {
    const definition = normalizeSkillDefinition(
      source.definition,
      `Expected the compiled skill definition at "${source.logicalPath}" to match the public eve shape.`,
    );
    return {
      kind: "skill",
      definition: {
        description: definition.description,
        files: definition.files,
        license: definition.license,
        logicalPath: source.logicalPath,
        markdown: definition.markdown,
        metadata:
          definition.metadata === undefined
            ? undefined
            : {
                ...definition.metadata,
              },
        name: stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
    };
  }

  // Module-backed skill — load the export and check for DynamicSentinel.
  const exportValue = await loadModuleBackedDefinition({
    agentRoot,
    externalDependencies: options.externalDependencies,
    kind: "skill",
    source,
  });

  if (isDynamicSentinel(exportValue)) {
    rejectDynamicSentinelFallback(
      exportValue,
      `Expected the skill export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
    );
    const slug = stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, "");
    return {
      kind: "dynamic-skill",
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

  const definition = normalizeSkillDefinition(
    exportValue,
    `Expected the skill export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
    kind: "skill",
    definition: {
      description: definition.description,
      files: definition.files,
      license: definition.license,
      logicalPath: source.logicalPath,
      markdown: definition.markdown,
      metadata:
        definition.metadata === undefined
          ? undefined
          : {
              ...definition.metadata,
            },
      name: stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
    },
  };
}

function compileSkillPackageSource(
  source: NamedSkillDefinition & SkillPackageSourceRef,
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
    name: source.name,
    referencesPath: source.referencesPath,
    rootPath: source.rootPath,
    scriptsPath: source.scriptsPath,
    skillId: source.skillId,
    skillFilePath: source.skillFilePath,
    sourceId: source.sourceId,
    sourceKind: "skill-package",
  };
}
