import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import { normalizeScheduleDefinition } from "#internal/authored-definition/core.js";
import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import type { CompiledScheduleDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  requireModuleBackedDefinitionLoadOptions,
  type SourceDefinitionCompileOptions,
} from "#compiler/normalize-helpers.js";

/**
 * Compiles one authored schedule into the normalized shape consumed by
 * the runtime scheduler.
 *
 * Schedules are single files: `schedules/<name>.{ts,md}`. The markdown
 * form always produces a fire-and-forget schedule (`markdown` body, no
 * `run`). The TypeScript form may declare either `markdown` or `run`
 * (exactly one). The schedule name is derived from the relative file
 * path under `schedules/` minus the extension
 * (`schedules/billing/invoice-sweep.ts` → `"billing/invoice-sweep"`).
 */
export async function compileScheduleDefinition(
  _agentRoot: string,
  source: ScheduleSourceRef,
  options: SourceDefinitionCompileOptions,
): Promise<CompiledScheduleDefinition> {
  const definition: ScheduleDefinition =
    source.sourceKind === "markdown"
      ? normalizeScheduleDefinition(
          source.definition,
          `Expected the compiled schedule definition at "${source.logicalPath}" to match the public eve shape.`,
        )
      : normalizeScheduleDefinition(
          await loadModuleBackedDefinition({
            binding: requireModuleBackedDefinitionLoadOptions(options, source.logicalPath).binding,
            kind: "schedule",
            registries: requireModuleBackedDefinitionLoadOptions(options, source.logicalPath)
              .registries,
            source,
          }),
          `Expected the schedule export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
        );

  const compiled = {
    cron: definition.cron,
    hasRun: definition.run !== undefined,
    logicalPath: source.logicalPath,
    name: deriveScheduleName(source.logicalPath),
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };

  const withMarkdown =
    definition.markdown === undefined
      ? compiled
      : { ...compiled, markdown: definition.markdown.trim() };

  return source.sourceKind === "module"
    ? { ...withMarkdown, sourceKind: "module" }
    : { ...withMarkdown, owner: options.owner, sourceKind: "markdown" };
}

function deriveScheduleName(logicalPath: string): string {
  return stripLogicalPathExtension(logicalPath).replace(/^schedules\//, "");
}
