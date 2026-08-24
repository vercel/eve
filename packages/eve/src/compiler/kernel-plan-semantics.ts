import type {
  CompiledAgentDefinition,
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledDynamicSkillDefinition,
  CompiledDynamicToolDefinition,
  CompiledSkillDefinition,
  CompiledToolDefinition,
  CompiledWebSearchProviderDefinition,
  CompiledWorkflowToolDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import type { AgentSourceComposition } from "#compiler/source-composition.js";
import type { CompiledSubagentSource } from "#compiler/source-composition.js";
import {
  getKernelCapabilityAtPath,
  getKernelCapabilityCanonicalPath,
  getKernelCompiledRequirements,
  getKernelReservedToolNames,
  getPreparedKernelTaskTargetReservations,
  getReplaceableKernelCapabilityAtRuntimeToolName,
  hasKernelCompiledRequirement,
  isKernelCapabilityName,
  isKernelSpecialDefinitionPath,
  isReservedKernelCapability,
  prepareKernelCapabilityPlan,
  type KernelCapabilityCompiledRequirement,
  type KernelCapabilityName,
  type KernelCapabilityPlan,
  type KernelSpecialDefinitionKind,
} from "#kernel/capabilities.js";

export interface KernelSemanticIssue {
  readonly message: string;
  readonly path: readonly (number | string)[];
}

export interface KernelSemanticContext {
  readonly isRoot: boolean;
  readonly nodeId: string;
  readonly subagentSources?: readonly KernelSemanticSubagentSource[];
  readonly tasksEnabled?: boolean;
}

export type KernelSemanticSubagentSource = Pick<
  CompiledSubagentSource,
  "backing" | "logicalPath" | "name" | "owner" | "sourceId"
>;

type KernelSemanticResources = {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly config?: CompiledAgentDefinition;
  readonly dynamicSkills: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools: readonly CompiledDynamicToolDefinition[];
  readonly kernelPlan: KernelCapabilityPlan;
  readonly skills: readonly CompiledSkillDefinition[];
  readonly sourceComposition: AgentSourceComposition;
  readonly tools: readonly CompiledToolDefinition[];
  readonly webSearchProvider?: CompiledWebSearchProviderDefinition;
  readonly workflowTool?: CompiledWorkflowToolDefinition;
};

const COMPILED_SPECIAL_DEFINITION_KINDS = [
  "web-search-tool",
  "workflow-tool",
] as const satisfies readonly KernelSpecialDefinitionKind[];

/**
 * Collects every relational kernel-plan issue without mutating or repairing the
 * artifact. Constructors and schema/load boundaries share this exact logic.
 */
export function collectKernelPlanSemanticIssues(
  resources: KernelSemanticResources,
  context: KernelSemanticContext,
): readonly KernelSemanticIssue[] {
  const issues: KernelSemanticIssue[] = [];
  const preparedNames: readonly string[] = resources.kernelPlan.prepared;
  const selected = readSelectedModuleSources(resources);
  const subagentSources = context.subagentSources ?? [];
  const disabled = new Set<KernelCapabilityName>();
  const replaced = new Set<KernelCapabilityName>();

  issues.push(...collectSelectedSubagentIssues(resources, context.nodeId, subagentSources));
  issues.push(
    ...collectRuntimeCapabilityIdentityIssues(resources, context.nodeId, subagentSources),
  );

  for (const entry of resources.sourceComposition.disabled) {
    const name = getKernelCapabilityAtPath(entry.source.logicalPath);
    if (name === undefined) continue;
    if (isReservedKernelCapability(name)) {
      issues.push({
        message: `Compiled node "${context.nodeId}" disables reserved kernel capability "${name}".`,
        path: ["sourceComposition", "disabled"],
      });
    } else {
      disabled.add(name);
    }
  }

  for (const source of selected) {
    const name = getKernelCapabilityAtPath(source.binding.logicalPath);
    if (name === undefined) continue;
    if (isReservedKernelCapability(name)) {
      issues.push({
        message: `Compiled node "${context.nodeId}" selects a source in reserved kernel slot "${name}".`,
        path: ["sourceComposition", "selected"],
      });
      continue;
    }
    const specialKind = getCompiledSpecialDefinitionKind(resources, source.sourceId);
    if (specialKind !== undefined) {
      if (source.binding.owner.kind === "extension") {
        issues.push({
          message: `Compiled special definition "${specialKind}" for kernel capability "${name}" cannot be extension-owned.`,
          path: ["sourceComposition", "selected"],
        });
      }
      continue;
    }
    if (isCompiledOrdinaryToolSource(resources, source.sourceId)) {
      if (source.binding.owner.kind !== "framework") {
        replaced.add(name);
      } else if (!hasKernelCompiledRequirement(name, "canonical-framework-tool")) {
        issues.push({
          message: `Compiled node "${context.nodeId}" selects an unsupported framework-authored source for native kernel capability "${name}".`,
          path: ["sourceComposition", "selected"],
        });
      }
      continue;
    }
    issues.push({
      message: `Compiled node "${context.nodeId}" selects canonical kernel source "${source.binding.logicalPath}" without a matching compiled resource.`,
      path: ["sourceComposition", "selected"],
    });
  }

  for (const source of subagentSources) {
    const replacement = getReplaceableKernelCapabilityAtRuntimeToolName(source.name);
    if (replacement !== undefined) replaced.add(replacement);
  }

  const frameworkLoadSkill = selected.some(
    (source) =>
      source.binding.owner.kind === "framework" &&
      isCompiledOrdinaryToolSource(resources, source.sourceId) &&
      selectedSourceHasCompiledRequirement(source, "canonical-framework-tool"),
  );
  const webSearch =
    resources.webSearchProvider !== undefined &&
    selected.some((source) =>
      isSelectedCompiledSpecialDefinition(resources, source, "web-search-tool"),
    );
  const workflow =
    resources.workflowTool !== undefined &&
    selected.some((source) =>
      isSelectedCompiledSpecialDefinition(resources, source, "workflow-tool"),
    );
  const tasksEnabled = context.tasksEnabled ?? resources.config?.experimental?.tasks === true;

  if (!context.isRoot && tasksEnabled) {
    issues.push({
      message: `Compiled child node "${context.nodeId}" cannot enable root-owned task orchestration.`,
      path: ["config", "experimental", "tasks"],
    });
  }

  if (resources.webSearchProvider !== undefined && !webSearch) {
    issues.push({
      message: `Compiled node "${context.nodeId}" has web-search configuration without its selected canonical source.`,
      path: ["webSearchProvider"],
    });
  }
  if (resources.workflowTool !== undefined && !workflow) {
    issues.push({
      message: `Compiled node "${context.nodeId}" has Workflow configuration without its selected canonical source.`,
      path: ["workflowTool"],
    });
  }

  const expected = prepareKernelCapabilityPlan({
    disabled,
    frameworkLoadSkill,
    hasSkills: resources.skills.length > 0 || resources.dynamicSkills.length > 0,
    isRoot: context.isRoot,
    replaced,
    tasksEnabled: context.isRoot && tasksEnabled,
    webSearch,
    workflow,
  }).prepared;
  if (!sameOrderedNames(preparedNames, expected)) {
    issues.push({
      message: `Compiled node "${context.nodeId}" kernel plan must exactly equal [${expected.join(", ")}], received [${preparedNames.join(", ")}].`,
      path: ["kernelPlan", "prepared"],
    });
  }

  for (const [index, name] of preparedNames.entries()) {
    if (!isKernelCapabilityName(name)) {
      issues.push({
        message: `Compiled node "${context.nodeId}" kernel plan contains unknown capability "${name}".`,
        path: ["kernelPlan", "prepared", index],
      });
      continue;
    }
    for (const requirement of getKernelCompiledRequirements(name)) {
      if (hasCompiledKernelRequirement(resources, selected, name, requirement)) continue;
      issues.push({
        message: `Prepared kernel capability "${name}" is missing compiled requirement "${requirement}".`,
        path: ["kernelPlan", "prepared"],
      });
    }
  }

  return issues;
}

export function assertKernelPlanSemantics(
  resources: KernelSemanticResources,
  context: KernelSemanticContext,
): void {
  const issues = collectKernelPlanSemanticIssues(resources, context);
  if (issues.length === 0) return;
  throw new Error(issues.map((issue) => issue.message).join("\n"));
}

/** Collects root, child, and cross-node kernel issues through one pure boundary. */
export function collectCompiledManifestKernelSemanticIssues(
  manifest: CompiledAgentManifest,
): readonly KernelSemanticIssue[] {
  const issues: KernelSemanticIssue[] = [];
  const targets = readManifestKernelTargets(manifest);
  for (const target of targets) {
    issues.push(
      ...collectKernelPlanSemanticIssues(target.resources, {
        isRoot: target.nodeId === "__root__",
        nodeId: target.nodeId,
        subagentSources: target.subagents.map((subagent) => subagent.source),
        tasksEnabled: target.resources.config?.experimental?.tasks === true,
      }).map((issue) => ({
        ...issue,
        path: [...target.path, ...issue.path],
      })),
    );
  }

  const taskTargetReservations = manifest.kernelPlan.prepared.every(isKernelCapabilityName)
    ? getPreparedKernelTaskTargetReservations(manifest.kernelPlan)
    : new Set<string>();
  if (taskTargetReservations.size === 0) return issues;

  for (const target of targets) {
    const runtimeNames = [
      ...target.resources.tools.map((tool, index) => ({
        name: tool.name,
        path: [...target.path, "tools", index],
      })),
      ...target.resources.dynamicTools.map((tool, index) => ({
        name: tool.slug,
        path: [...target.path, "dynamicTools", index],
      })),
      ...target.subagents.map((subagent) => ({
        name: subagent.source.name,
        path: subagent.namePath,
      })),
    ];
    for (const runtimeName of runtimeNames) {
      if (!taskTargetReservations.has(runtimeName.name)) continue;
      issues.push({
        message: `Compiled task-targetable node "${target.nodeId}" defines reserved session task-control name "${runtimeName.name}" while the root capability survives composition.`,
        path: runtimeName.path,
      });
    }
  }

  return issues;
}

/** Validates the root and every local child, including session-only collisions. */
export function assertCompiledManifestKernelSemantics(manifest: CompiledAgentManifest): void {
  const issues = collectCompiledManifestKernelSemanticIssues(manifest);
  if (issues.length === 0) return;
  throw new Error(issues.map((issue) => issue.message).join("\n"));
}

function readManifestKernelTargets(manifest: CompiledAgentManifest): readonly {
  readonly nodeId: string;
  readonly path: readonly (number | string)[];
  readonly resources: KernelSemanticResources;
  readonly subagents: readonly {
    readonly namePath: readonly (number | string)[];
    readonly source: KernelSemanticSubagentSource;
  }[];
}[] {
  const nodesById = new Map(
    manifest.subagents.map((subagent, index) => [subagent.nodeId, { index, subagent }] as const),
  );
  const resourceTargets = [
    { nodeId: "__root__", path: [] as const, resources: manifest },
    ...manifest.subagents.map((subagent, index) => ({
      nodeId: subagent.nodeId,
      path: ["subagents", index, "agent"] as const,
      resources: subagent.agent,
    })),
  ];

  return resourceTargets.map((target) => {
    const local = manifest.subagentEdges.flatMap((edge) => {
      if (edge.parentNodeId !== target.nodeId) return [];
      const child = nodesById.get(edge.childNodeId);
      return child === undefined
        ? []
        : [{ namePath: ["subagents", child.index, "name"], source: child.subagent }];
    });
    const remote = target.resources.remoteAgents.map((source, index) => ({
      namePath: [...target.path, "remoteAgents", index, "name"],
      source,
    }));
    return { ...target, subagents: [...local, ...remote] };
  });
}

function readSelectedModuleSources(resources: KernelSemanticResources): readonly {
  readonly binding: CompiledModuleBinding;
  readonly sourceId: string;
}[] {
  return resources.sourceComposition.selected.flatMap((entry) => {
    if (entry.sourceKind !== "module") return [];
    const binding = resources.bindings[entry.sourceId];
    return binding === undefined ? [] : [{ binding, sourceId: entry.sourceId }];
  });
}

function collectSelectedSubagentIssues(
  resources: KernelSemanticResources,
  nodeId: string,
  subagentSources: readonly KernelSemanticSubagentSource[],
): readonly KernelSemanticIssue[] {
  const issues: KernelSemanticIssue[] = [];
  const selected = resources.sourceComposition.selected.flatMap((entry, index) =>
    entry.sourceKind === "non-module" && entry.source.sourceKind === "subagent"
      ? [{ entry, index }]
      : [],
  );
  const explicitBySourceId = new Map<string, KernelSemanticSubagentSource>();

  for (const source of subagentSources) {
    if (explicitBySourceId.has(source.sourceId)) {
      issues.push({
        message: `Compiled node "${nodeId}" has duplicate explicit subagent source "${source.sourceId}".`,
        path: ["sourceComposition", "selected"],
      });
      continue;
    }
    explicitBySourceId.set(source.sourceId, source);
    const selectedEntry = selected.find((entry) => entry.entry.source.sourceId === source.sourceId);
    if (selectedEntry === undefined) {
      issues.push({
        message: `Compiled node "${nodeId}" is missing selected composition for explicit subagent "${source.name}".`,
        path: ["sourceComposition", "selected"],
      });
      continue;
    }
    const expectedSlot = `subagents/${source.name}`;
    const descriptor = selectedEntry.entry.source;
    if (descriptor.sourceKind !== "subagent") continue;
    if (
      selectedEntry.entry.slot !== expectedSlot ||
      descriptor.logicalPath !== source.logicalPath ||
      JSON.stringify(descriptor.owner) !== JSON.stringify(source.owner) ||
      JSON.stringify(descriptor.backing) !== JSON.stringify(source.backing)
    ) {
      issues.push({
        message: `Compiled node "${nodeId}" selected subagent composition does not match explicit subagent "${source.name}".`,
        path: ["sourceComposition", "selected", selectedEntry.index],
      });
    }
  }

  for (const selectedEntry of selected) {
    if (explicitBySourceId.has(selectedEntry.entry.source.sourceId)) continue;
    issues.push({
      message: `Compiled node "${nodeId}" selects dangling subagent source "${selectedEntry.entry.source.sourceId}" without an explicit compiled subagent record.`,
      path: ["sourceComposition", "selected", selectedEntry.index],
    });
  }

  return issues;
}

function collectRuntimeCapabilityIdentityIssues(
  resources: KernelSemanticResources,
  nodeId: string,
  subagentSources: readonly KernelSemanticSubagentSource[],
): readonly KernelSemanticIssue[] {
  const issues: KernelSemanticIssue[] = [];
  const claimed = new Map<string, string>();
  const identities = [
    ...[...getKernelReservedToolNames(resources.kernelPlan)].map((name) => ({
      label: `kernel capability "${name}"`,
      name,
      path: ["kernelPlan", "prepared"] as const,
    })),
    ...resources.tools.flatMap((tool, index) =>
      isPreparedFrameworkKernelSource(resources, tool)
        ? []
        : [
            {
              label: `tool source "${tool.logicalPath}"`,
              name: tool.name,
              path: ["tools", index, "name"] as const,
            },
          ],
    ),
    ...resources.dynamicTools.map((tool, index) => ({
      label: `dynamic tool source "${tool.logicalPath}"`,
      name: tool.slug,
      path: ["dynamicTools", index, "slug"] as const,
    })),
    ...subagentSources.map((source) => ({
      label: `subagent source "${source.logicalPath}"`,
      name: source.name,
      path: ["sourceComposition", "selected"] as const,
    })),
  ];

  for (const identity of identities) {
    const previous = claimed.get(identity.name);
    if (previous !== undefined) {
      issues.push({
        message: `Compiled node "${nodeId}" runtime capability name "${identity.name}" collides between ${previous} and ${identity.label}.`,
        path: identity.path,
      });
      continue;
    }
    claimed.set(identity.name, identity.label);
  }

  return issues;
}

function isPreparedFrameworkKernelSource(
  resources: KernelSemanticResources,
  tool: CompiledToolDefinition,
): boolean {
  const name = getKernelCapabilityAtPath(tool.logicalPath);
  return (
    name !== undefined &&
    name === tool.name &&
    resources.kernelPlan.prepared.includes(name) &&
    hasKernelCompiledRequirement(name, "canonical-framework-tool") &&
    resources.bindings[tool.sourceId]?.owner.kind === "framework" &&
    resources.sourceComposition.selected.some(
      (entry) => entry.sourceKind === "module" && entry.sourceId === tool.sourceId,
    )
  );
}

function isCompiledOrdinaryToolSource(
  resources: KernelSemanticResources,
  sourceId: string,
): boolean {
  return (
    resources.tools.some((tool) => tool.sourceId === sourceId) ||
    resources.dynamicTools.some((tool) => tool.sourceId === sourceId)
  );
}

function selectedSourceHasCompiledRequirement(
  source: ReturnType<typeof readSelectedModuleSources>[number],
  requirement: KernelCapabilityCompiledRequirement,
): boolean {
  const name = getKernelCapabilityAtPath(source.binding.logicalPath);
  return name !== undefined && hasKernelCompiledRequirement(name, requirement);
}

function getCompiledSpecialDefinitionKind(
  resources: KernelSemanticResources,
  sourceId: string,
): KernelSpecialDefinitionKind | undefined {
  if (isCompiledOrdinaryToolSource(resources, sourceId)) return undefined;
  return COMPILED_SPECIAL_DEFINITION_KINDS.find(
    (kind) => readCompiledSpecialDefinition(resources, kind)?.sourceId === sourceId,
  );
}

function isSelectedCompiledSpecialDefinition(
  resources: KernelSemanticResources,
  source: ReturnType<typeof readSelectedModuleSources>[number],
  kind: KernelSpecialDefinitionKind,
): boolean {
  if (isCompiledOrdinaryToolSource(resources, source.sourceId)) return false;
  const definition = readCompiledSpecialDefinition(resources, kind);
  return (
    definition?.sourceId === source.sourceId &&
    isKernelSpecialDefinitionPath(source.binding.logicalPath, kind)
  );
}

function readCompiledSpecialDefinition(
  resources: KernelSemanticResources,
  kind: KernelSpecialDefinitionKind,
): CompiledWebSearchProviderDefinition | CompiledWorkflowToolDefinition | undefined {
  return kind === "web-search-tool" ? resources.webSearchProvider : resources.workflowTool;
}

function hasCompiledKernelRequirement(
  resources: KernelSemanticResources,
  selected: ReturnType<typeof readSelectedModuleSources>,
  name: KernelCapabilityName,
  requirement: KernelCapabilityCompiledRequirement,
): boolean {
  switch (requirement) {
    case "canonical-framework-tool": {
      const canonicalPath = getKernelCapabilityCanonicalPath(name);
      return resources.tools.some((tool) => {
        if (tool.logicalPath !== canonicalPath) return false;
        const binding = resources.bindings[tool.sourceId];
        return (
          binding?.owner.kind === "framework" &&
          selected.some((source) => source.sourceId === tool.sourceId)
        );
      });
    }
    case "skills":
      return resources.skills.length > 0 || resources.dynamicSkills.length > 0;
    case "web-search-provider":
      return resources.webSearchProvider !== undefined;
    case "workflow-config":
      return resources.workflowTool !== undefined;
  }
}

function sameOrderedNames(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
}

export type KernelSemanticCompiledResources =
  | CompiledAgentManifest
  | CompiledAgentNodeManifest
  | CompiledAgentResources;
