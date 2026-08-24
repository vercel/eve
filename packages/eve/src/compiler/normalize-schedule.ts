import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import { normalizeScheduleDefinition } from "#internal/authored-definition/core.js";
import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import type { CompiledScheduleDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";

interface ScheduleCompileOptions {
  readonly name?: string;
}
type ModuleScheduleCompileOptions = ScheduleCompileOptions & ModuleBackedDefinitionLoadOptions;

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
export function compileScheduleDefinition(
  source: Extract<ScheduleSourceRef, { readonly sourceKind: "module" }>,
  options: ModuleScheduleCompileOptions,
): Promise<CompiledScheduleDefinition>;
export function compileScheduleDefinition(
  source: Exclude<ScheduleSourceRef, { readonly sourceKind: "module" }>,
  options?: ScheduleCompileOptions,
): Promise<CompiledScheduleDefinition>;
export async function compileScheduleDefinition(
  source: ScheduleSourceRef,
  options: ScheduleCompileOptions | ModuleScheduleCompileOptions = {},
): Promise<CompiledScheduleDefinition> {
  let definition: ScheduleDefinition;
  if (source.sourceKind === "markdown") {
    definition = normalizeScheduleDefinition(
      source.definition,
      `Expected the compiled schedule definition at "${source.logicalPath}" to match the public eve shape.`,
    );
  } else {
    const moduleOptions = requireModuleOptions(options, source.logicalPath);
    definition = normalizeScheduleDefinition(
      await loadModuleBackedDefinition({
        binding: moduleOptions.binding,
        kind: "schedule",
        moduleLoader: moduleOptions.moduleLoader,
        source,
      }),
      `Expected the schedule export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
    );
  }

  const base = {
    cron: definition.cron,
    hasRun: definition.run !== undefined,
    logicalPath: source.logicalPath,
    name: options.name ?? deriveScheduleName(source.logicalPath),
    sourceId: source.sourceId,
  };
  const compiled: CompiledScheduleDefinition =
    source.sourceKind === "module"
      ? { ...base, exportName: source.exportName, sourceKind: "module" }
      : { ...base, sourceKind: "markdown" };

  if (definition.markdown !== undefined) {
    return { ...compiled, markdown: definition.markdown.trim() };
  }

  return compiled;
}

function requireModuleOptions(
  options: ScheduleCompileOptions | ModuleScheduleCompileOptions,
  logicalPath: string,
): ModuleScheduleCompileOptions {
  if (!("binding" in options) || options.binding === undefined) {
    throw new Error(`Module-backed schedule "${logicalPath}" requires a selected binding.`);
  }
  return options;
}

function deriveScheduleName(logicalPath: string): string {
  return stripLogicalPathExtension(logicalPath).replace(/^schedules\//, "");
}
