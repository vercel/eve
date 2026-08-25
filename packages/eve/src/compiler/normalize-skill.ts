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
  source: SkillSourceRef,
  exportValue?: unknown,
): CompiledSkillEntry {
  if (source.sourceKind === "skill-package") {
    return { kind: "skill", definition: compileSkillPackageSource(source) };
  }

  if (source.sourceKind === "markdown") {
    const definition = normalizeSkillDefinition(
      source.definition,
      `Expected the compiled skill definition at "${source.logicalPath}" to match the public eve shape.`,
    );
    const compiled: CompiledSkillDefinition = {
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
      name: stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
    };
    if (definition.files !== undefined) {
      (compiled as { files?: typeof definition.files }).files = definition.files;
    }
    return { kind: "skill", definition: compiled };
  }

  // Module-backed skill — the caller loaded the export through its
  // binding; classify DynamicSentinel vs static skill.
  if (isDynamicSentinel(exportValue)) {
    assertResolverOnlyDynamicSentinel(
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

  const compiled: CompiledSkillDefinition = {
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
    name: stripLogicalPathExtension(source.logicalPath).replace(/^skills\//, ""),
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };
  if (definition.files !== undefined) {
    (compiled as { files?: typeof definition.files }).files = definition.files;
  }
  return { kind: "skill", definition: compiled };
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
