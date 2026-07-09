import { join as joinPath, relative as relativePath } from "node:path";

import type { AgentSourceManifest, ResolvedExtensionMount } from "#discover/manifest.js";
import type {
  CompiledConnectionDefinition,
  CompiledDynamicInstructionsDefinition,
  CompiledDynamicSkillDefinition,
  CompiledDynamicToolDefinition,
  CompiledHookDefinition,
  CompiledSkillDefinition,
  CompiledToolDefinition,
} from "#compiler/manifest.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
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
    role: "extension",
  });

  if (mount.overrides === undefined) {
    return base.contributions;
  }

  // Overrides are consumer-authored files, so they are NOT extension-scoped. The
  // `ext-override:` prefix keeps their module-map keys distinct from the
  // extension's own `ext:<ns>:` modules while deliberately not matching the
  // loader's `^ext:<ns>:` scope pattern, so dev and prod both treat them unscoped.
  const overrides = await composeManifestContributions({
    manifest: mount.overrides,
    namespace: mount.namespace,
    consumerAgentRoot,
    options,
    sourceIdScope: `ext-override:${mount.namespace}`,
    role: "override",
  });

  // Consumer overrides win: list them first so first-registration-wins dedup
  // keeps the override over the extension's same-named contribution.
  const merged = mergeContributions(overrides.contributions, base.contributions);

  return applyOverrideDisables({
    merged,
    disables: overrides.disabledToolTargets,
    extensionToolNames: new Set(base.contributions.tools.map((tool) => tool.name)),
    extensionDynamicToolSlugs: new Set(base.contributions.dynamicTools.map((tool) => tool.slug)),
    namespace: mount.namespace,
  });
}

export interface DisabledToolTarget {
  /** Namespaced target, e.g. `crm__search`. */
  readonly name: string;
  /** Override-relative authored path, e.g. `tools/search.ts`, for diagnostics. */
  readonly logicalPath: string;
}

interface ComposedContributions {
  readonly contributions: CompiledExtensionContributions;
  readonly disabledToolTargets: readonly DisabledToolTarget[];
}

/**
 * Removes the extension tools an override slot opted out of with `disableTool()`.
 * A `disableTool()` targets a slot by name, so it removes the extension's
 * same-named static tool or dynamic resolver — whichever kind occupies the slot.
 * A disable that matches neither throws rather than silently disabling nothing.
 *
 * Exported for unit testing.
 */
export function applyOverrideDisables(input: {
  readonly merged: CompiledExtensionContributions;
  readonly disables: readonly DisabledToolTarget[];
  readonly extensionToolNames: ReadonlySet<string>;
  readonly extensionDynamicToolSlugs: ReadonlySet<string>;
  readonly namespace: string;
}): CompiledExtensionContributions {
  if (input.disables.length === 0) {
    return input.merged;
  }
  const prefixLength = input.namespace.length + 2; // strip the `<ns>__` prefix
  const removed = new Set<string>();
  for (const disable of input.disables) {
    if (
      !input.extensionToolNames.has(disable.name) &&
      !input.extensionDynamicToolSlugs.has(disable.name)
    ) {
      const available = [...input.extensionToolNames, ...input.extensionDynamicToolSlugs]
        .map((name) => name.slice(prefixLength))
        .sort();
      throw new Error(
        `The override "agent/extensions/${input.namespace}/${disable.logicalPath}" calls disableTool(), ` +
          `but the "${input.namespace}" extension contributes no tool named "${disable.name.slice(prefixLength)}". ` +
          `It contributes: ${available.length > 0 ? available.join(", ") : "(no tools)"}.`,
      );
    }
    removed.add(disable.name);
  }
  return {
    ...input.merged,
    tools: input.merged.tools.filter((tool) => !removed.has(tool.name)),
    dynamicTools: input.merged.dynamicTools.filter((tool) => !removed.has(tool.slug)),
  };
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
  readonly role: "extension" | "override";
}): Promise<ComposedContributions> {
  const { manifest, namespace, consumerAgentRoot, options, sourceIdScope, role } = input;
  const sourceRoot = manifest.agentRoot;
  const prefix = `${namespace}__`;
  const scopeSourceId = (sourceId: string): string => `${sourceIdScope}:${sourceId}`;
  const rebase = (logicalPath: string): string =>
    relativePath(consumerAgentRoot, joinPath(sourceRoot, logicalPath)).replaceAll("\\", "/");

  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledToolTargets: DisabledToolTarget[] = [];
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
    } else if (entry.kind === "enable-workflow") {
      throw new Error(
        `${describeExtensionSource(role, namespace, source.logicalPath)} enables the Workflow tool, ` +
          `but the Workflow tool is the consuming agent's to enable, not an extension's. Remove it.`,
      );
    } else if (role === "extension") {
      throw new Error(
        `${describeExtensionSource(role, namespace, source.logicalPath)} calls disableTool(), ` +
          `but an extension cannot disable framework tools — that is the consuming agent's to own. Remove it.`,
      );
    } else {
      disabledToolTargets.push({ name: `${prefix}${entry.name}`, logicalPath: source.logicalPath });
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
        extensionNamespace: namespace,
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
    contributions: {
      tools,
      dynamicTools,
      hooks,
      skills,
      dynamicSkills,
      dynamicInstructions,
      connections,
      instructionFragments,
    },
    disabledToolTargets,
  };
}

function describeExtensionSource(
  role: "extension" | "override",
  namespace: string,
  logicalPath: string,
): string {
  return role === "override"
    ? `The override "agent/extensions/${namespace}/${logicalPath}"`
    : `The "${namespace}" extension's "${logicalPath}"`;
}

/**
 * Merges two composed contribution sets with earlier-set-wins precedence per
 * composed name. Named contributions (tools, connections, skills, dynamic
 * tools) dedup by their model-facing identifier so an override shadows the
 * extension's same-named entry; unnamed contributions (hooks, dynamic skills,
 * dynamic instructions, instruction fragments) simply concatenate.
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
