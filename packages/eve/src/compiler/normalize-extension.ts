import { join as joinPath, relative as relativePath } from "node:path";

import type { AgentSourceManifest, ResolvedExtensionMount } from "#discover/manifest.js";
import type {
  CompiledConnectionDefinition,
  CompiledDynamicInstructionsDefinition,
  CompiledDynamicSkillDefinition,
  CompiledDynamicToolDefinition,
  CompiledHookDefinition,
  CompiledScheduleDefinition,
  CompiledSkillDefinition,
  CompiledToolDefinition,
} from "#compiler/manifest.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";

/**
 * Contributions one mounted extension composes into the consuming agent,
 * already namespaced by the mount and rebased onto the consumer's agent root.
 */
export interface CompiledExtensionContributions {
  readonly tools: CompiledToolDefinition[];
  readonly dynamicTools: CompiledDynamicToolDefinition[];
  readonly hooks: CompiledHookDefinition[];
  readonly schedules: CompiledScheduleDefinition[];
  readonly skills: CompiledSkillDefinition[];
  readonly dynamicSkills: CompiledDynamicSkillDefinition[];
  readonly dynamicInstructions: CompiledDynamicInstructionsDefinition[];
  readonly connections: CompiledConnectionDefinition[];
  readonly instructionFragments: string[];
}

/**
 * Compiles one mounted extension's source tree and namespaces its
 * contributions by the mount name. Module-backed contributions keep loading
 * from the extension package because their `logicalPath` is rebased to a
 * consumer-relative path — the module-map codegen resolves it against the
 * consumer's agent root, reaching into the extension package unchanged.
 *
 * When the mount was authored as a directory (`extensions/<ns>/`), any
 * consumer-authored override slots are composed under the same namespace and
 * win on name collision: an override tool `<ns>__search` shadows the
 * extension's own `<ns>__search`.
 */
export async function compileExtensionContributions(input: {
  readonly mount: ResolvedExtensionMount;
  readonly context: ManifestCompileContext;
  readonly consumerAgentRoot: string;
  readonly externalDependencies: readonly string[];
}): Promise<CompiledExtensionContributions> {
  const { mount, consumerAgentRoot } = input;
  const options = { externalDependencies: input.externalDependencies };

  const base = await composeManifestContributions({
    manifest: mount.manifest,
    namespace: mount.namespace,
    consumerAgentRoot,
    options,
    sourceIdScope: `ext:${mount.namespace}`,
  });

  if (mount.overrides === undefined) {
    return base;
  }

  // Overrides are consumer-authored files under the consumer's agent root, so —
  // like the base contributions when consumer files shadow them — they are NOT
  // extension-scoped. The `ext-override:` prefix keeps their module-map keys
  // distinct from the extension's own `ext:<ns>:` modules without matching the
  // loader's `^ext:<ns>:` scope pattern, so dev and prod treat them identically
  // (unscoped): an override that needs the extension's config is out of scope.
  const overrides = await composeManifestContributions({
    manifest: mount.overrides,
    namespace: mount.namespace,
    consumerAgentRoot,
    options,
    sourceIdScope: `ext-override:${mount.namespace}`,
  });

  // Consumer overrides win: list them first so the first-registration-wins
  // dedup in `compileAgentManifest` keeps the override and drops the
  // extension's same-named contribution.
  return mergeContributions(overrides, base);
}

interface ComposeOptions {
  readonly externalDependencies: readonly string[];
}

/**
 * Compiles one agent-shaped manifest into namespaced extension contributions
 * rebased onto the consumer's agent root. Used for both the extension's own
 * source tree and a directory mount's consumer override slots.
 */
async function composeManifestContributions(input: {
  readonly manifest: AgentSourceManifest;
  readonly namespace: string;
  readonly consumerAgentRoot: string;
  readonly options: ComposeOptions;
  readonly sourceIdScope: string;
}): Promise<CompiledExtensionContributions> {
  const { manifest, namespace, consumerAgentRoot, options, sourceIdScope } = input;
  const sourceRoot = manifest.agentRoot;
  const prefix = `${namespace}__`;
  const scopeSourceId = (sourceId: string): string => `${sourceIdScope}:${sourceId}`;
  const rebase = (logicalPath: string): string =>
    relativePath(consumerAgentRoot, joinPath(sourceRoot, logicalPath)).replaceAll("\\", "/");

  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  for (const source of manifest.tools) {
    const entry = await compileToolEntry(sourceRoot, source, options);
    if (entry.kind === "tool") {
      tools.push({
        ...entry.definition,
        name: `${prefix}${entry.definition.name}`,
        sourceId: scopeSourceId(entry.definition.sourceId),
        logicalPath: rebase(entry.definition.logicalPath),
      });
    } else if (entry.kind === "dynamic-tool") {
      dynamicTools.push({
        ...entry.definition,
        slug: `${prefix}${entry.definition.slug}`,
        extensionNamespace: namespace,
        sourceId: scopeSourceId(entry.definition.sourceId),
        logicalPath: rebase(entry.definition.logicalPath),
      });
    }
  }

  const hooks: CompiledHookDefinition[] = manifest.hooks.map((source) => {
    const hook = compileHookEntry(source);
    return {
      ...hook,
      slug: `${prefix}${hook.slug}`,
      sourceId: scopeSourceId(hook.sourceId),
      logicalPath: rebase(hook.logicalPath),
    };
  });

  const schedules: CompiledScheduleDefinition[] = (
    await Promise.all(
      manifest.schedules.map((source) => compileScheduleDefinition(sourceRoot, source, options)),
    )
  ).map((schedule) => ({
    ...schedule,
    name: `${prefix}${schedule.name}`,
    sourceId: scopeSourceId(schedule.sourceId),
    logicalPath: rebase(schedule.logicalPath),
  }));

  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];
  for (const source of manifest.skills) {
    const entry = await compileSkillSource(sourceRoot, source, options);
    if (entry.kind === "skill") {
      skills.push({
        ...entry.definition,
        name: `${prefix}${entry.definition.name}`,
        sourceId: scopeSourceId(entry.definition.sourceId),
        logicalPath: rebase(entry.definition.logicalPath),
      });
    } else {
      dynamicSkills.push({
        ...entry.definition,
        slug: `${prefix}${entry.definition.slug}`,
        sourceId: scopeSourceId(entry.definition.sourceId),
        logicalPath: rebase(entry.definition.logicalPath),
      });
    }
  }

  const connections: CompiledConnectionDefinition[] = (
    await Promise.all(
      manifest.connections.map((source) =>
        compileConnectionDefinition(sourceRoot, source, options),
      ),
    )
  ).map((connection) => ({
    ...connection,
    connectionName: `${prefix}${connection.connectionName}`,
    sourceId: scopeSourceId(connection.sourceId),
    logicalPath: rebase(connection.logicalPath),
  }));

  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];
  const instructionFragments: string[] = [];
  for (const source of manifest.instructions) {
    const entry = await compileInstructionsEntry(sourceRoot, source, options);
    if (entry.kind === "instructions") {
      instructionFragments.push(entry.definition.markdown);
    } else {
      dynamicInstructions.push({
        ...entry.definition,
        slug: `${prefix}${entry.definition.slug}`,
        sourceId: scopeSourceId(entry.definition.sourceId),
        logicalPath: rebase(entry.definition.logicalPath),
      });
    }
  }

  return {
    tools,
    dynamicTools,
    hooks,
    schedules,
    skills,
    dynamicSkills,
    dynamicInstructions,
    connections,
    instructionFragments,
  };
}

/**
 * Merges two composed contribution sets with earlier-set-wins precedence per
 * composed name. Named contributions (tools, connections, skills, schedules,
 * dynamic tools) dedup by their model-facing identifier so an override shadows
 * the extension's same-named entry; unnamed contributions (hooks, dynamic
 * skills, dynamic instructions, instruction fragments) simply concatenate.
 *
 * Exported for unit testing: passing the consumer overrides as `primary` and
 * the extension's own contributions as `secondary` yields consumer-wins
 * shadowing on name collision.
 */
export function mergeContributions(
  primary: CompiledExtensionContributions,
  secondary: CompiledExtensionContributions,
): CompiledExtensionContributions {
  return {
    tools: dedupeBy([...primary.tools, ...secondary.tools], (tool) => tool.name),
    dynamicTools: dedupeBy(
      [...primary.dynamicTools, ...secondary.dynamicTools],
      (tool) => tool.slug,
    ),
    connections: dedupeBy(
      [...primary.connections, ...secondary.connections],
      (connection) => connection.connectionName,
    ),
    skills: dedupeBy([...primary.skills, ...secondary.skills], (skill) => skill.name),
    schedules: dedupeBy(
      [...primary.schedules, ...secondary.schedules],
      (schedule) => schedule.name,
    ),
    hooks: [...primary.hooks, ...secondary.hooks],
    dynamicSkills: [...primary.dynamicSkills, ...secondary.dynamicSkills],
    dynamicInstructions: [...primary.dynamicInstructions, ...secondary.dynamicInstructions],
    instructionFragments: [...primary.instructionFragments, ...secondary.instructionFragments],
  };
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const identifier = key(item);
    if (seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    result.push(item);
  }
  return result;
}
