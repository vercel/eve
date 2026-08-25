import { join } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { mountRefNamespace, packageStateNamespace } from "#discover/extensions.js";
import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  type CompiledAgentDefinition,
  type CompiledAgentManifest,
  type CompiledChannelDefinition,
  type CompiledConnectionDefinition,
  type CompiledDynamicInstructionsDefinition,
  type CompiledExtensionMount,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledHookDefinition,
  type CompiledInstructionsDefinition,
  type CompiledSandboxDefinition,
  type CompiledScheduleDefinition,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  type CompiledWorkflowToolDefinition,
  type ComposedSourceDescriptor,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { WebSearchProvider } from "#shared/web-search.js";
import {
  createAgentSourceRegistry,
  type AgentSourceRegistry,
  type CompiledModuleBinding,
} from "#compiler/source-graph.js";
import {
  composeNodeSources,
  type ComposedCandidate,
  type NodeCompositionState,
  type NodeExtensionScope,
} from "#compiler/compose-sources.js";
import { getFrameworkAgentSourceRegistry } from "#internal/agent-sources.js";
import {
  createCompiledRuntimeModelCatalogLoader,
  type CompiledRuntimeModelCatalogLoader,
} from "#compiler/model-catalog.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import {
  loadComposedModuleDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileSubagentGraph, type SubagentSelection } from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import { planChannelRoutes } from "#compiler/route-plan.js";
import { validateCompiledAgentManifest } from "#compiler/validate-manifest.js";

/** Options accepted by {@link compileAgentManifest}. */
export interface CompileAgentManifestOptions {
  /**
   * Programmatic application sources composed at the application layer.
   * Used by the in-memory test compiler; filesystem compilation has none.
   */
  readonly applicationRegistry?: AgentSourceRegistry;
  /**
   * Compiler diagnostic accumulator that stays open until route planning
   * completes. Route warnings are appended here and contribute to the
   * serialized compiler diagnostics artifact.
   */
  readonly diagnostics?: DiscoverDiagnostic[];
  /** Compile-time model catalog override (hermetic in-memory compilation). */
  readonly modelCatalog?: CompiledRuntimeModelCatalogLoader;
  /**
   * Framework source registry. Defaults to the closed framework registry.
   */
  readonly registry?: AgentSourceRegistry;
}

/**
 * Compiles one discovery manifest into the normalized manifest loaded by
 * the runtime. Framework defaults, extension packages, extension overrides,
 * and application sources compose once per node before normalization; the
 * result carries required bindings, the persisted composition report, and
 * the compiler-owned channel route plan.
 */
export async function compileAgentManifest(
  manifest: AgentSourceManifest,
  options: CompileAgentManifestOptions = {},
): Promise<CompiledAgentManifest> {
  const diagnostics = options.diagnostics ?? [];
  const frameworkRegistry = options.registry ?? getFrameworkAgentSourceRegistry();
  const applicationRegistry = options.applicationRegistry;
  const loaderRegistry =
    applicationRegistry === undefined
      ? frameworkRegistry
      : createAgentSourceRegistry(
          [...frameworkRegistry.registrations, ...applicationRegistry.registrations],
          { allowFrameworkSlots: true },
        );
  const context: ManifestCompileContext = {
    applicationRegistry,
    frameworkRegistry,
    modelCatalog: options.modelCatalog ?? createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
    registry: loaderRegistry,
  };
  const parts = await compileAgentNodeParts(manifest, context, {
    isRoot: true,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
  });
  const subagentGraph = await compileSubagentGraph({
    appRoot: manifest.appRoot,
    compileAgentNodeParts,
    context,
    externalDependencies: parts.effectiveExternalDependencies,
    parentAgentRoot: manifest.agentRoot,
    parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagents: parts.selectedSubagents,
  });

  const backgroundTool = [parts.resources.tools, ...subagentGraph.nodes.map((n) => n.agent.tools)]
    .flat()
    .find((tool) => tool.execution === "background");
  if (backgroundTool !== undefined && parts.config.experimental?.tasks !== true) {
    throw new Error(
      `Background tool "${backgroundTool.name}" requires experimental.tasks: true in the root agent config.`,
    );
  }

  const channelRoutes = planChannelRoutes({
    channels: parts.resources.channels,
    describeSource: parts.describeSource,
    diagnostics,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
  });

  const compiledManifest = createCompiledAgentManifest({
    ...parts.resources,
    bindings: {
      ...parts.bindings,
      ...subagentGraph.parentScopedBindings,
    },
    channelRoutes,
    config: parts.config,
    remoteAgents: subagentGraph.remoteAgents,
    sourceComposition: parts.compositionState.toComposition(),
    subagentEdges: subagentGraph.edges,
    subagents: subagentGraph.nodes,
  });
  validateCompiledAgentManifest(compiledManifest);
  return compiledManifest;
}

/**
 * Compiled output of one node's phase-one config composition and phase-two
 * resource normalization, before its subagent graph is attached.
 */
export interface AgentNodeParts {
  readonly bindings: Record<string, CompiledModuleBinding>;
  readonly compositionState: NodeCompositionState;
  readonly config: CompiledAgentDefinition;
  readonly describeSource: (sourceId: string) => ComposedSourceDescriptor | undefined;
  readonly effectiveExternalDependencies: readonly string[];
  readonly resources: CompiledNodeResources;
  readonly selectedSubagents: readonly SubagentSelection[];
}

/** Resources-only variant for dynamic subagent nodes (no config slot). */
export interface AgentResourceParts extends Omit<AgentNodeParts, "config"> {
  readonly config?: undefined;
}

interface CompiledNodeResources {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly channels: CompiledChannelDefinition[];
  readonly connections: CompiledConnectionDefinition[];
  readonly diagnosticsSummary: AgentSourceManifest["diagnosticsSummary"];
  readonly dynamicInstructions: CompiledDynamicInstructionsDefinition[];
  readonly dynamicSkills: CompiledDynamicSkillDefinition[];
  readonly dynamicTools: CompiledDynamicToolDefinition[];
  readonly extensionMounts: CompiledExtensionMount[];
  readonly hooks: CompiledHookDefinition[];
  readonly instructions: CompiledInstructionsDefinition[];
  readonly sandbox: CompiledSandboxDefinition;
  readonly sandboxWorkspaces: {
    logicalPath: string;
    rootEntries: string[];
    sourceId: string;
    sourcePath: string;
  }[];
  readonly schedules: CompiledScheduleDefinition[];
  readonly skills: CompiledSkillDefinition[];
  readonly tools: CompiledToolDefinition[];
  readonly webSearchProvider?: WebSearchProvider;
  readonly workflowTool?: CompiledWorkflowToolDefinition;
}

export interface CompileAgentNodePartsOptions {
  readonly agentConfigDefinition?: unknown;
  readonly allowRootOnlyConfig?: boolean;
  readonly configDisplayPath?: string;
  readonly externalDependencies?: readonly string[];
  readonly isRoot?: boolean;
  /** Skips the config slot entirely for dynamic subagent resource nodes. */
  readonly mode?: "node" | "resources";
  readonly nodeExtensionScope?: NodeExtensionScope;
  readonly nodeId: string;
}

export type CompileAgentNodePartsFn = typeof compileAgentNodeParts;

/**
 * Compiles one agent node through the two-phase composition pipeline:
 * the config slot composes and loads first, build settings derive from the
 * selected config, and every other selected winner loads with those
 * settings. Losing candidates never receive bindings and never execute.
 */
export async function compileAgentNodeParts(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentNodePartsOptions,
): Promise<AgentNodeParts>;
export async function compileAgentNodeParts(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentNodePartsOptions & { readonly mode: "resources" },
): Promise<AgentResourceParts>;
export async function compileAgentNodeParts(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentNodePartsOptions,
): Promise<AgentNodeParts | AgentResourceParts> {
  const mode = options.mode ?? "node";
  const composed = composeNodeSources({
    applicationRegistry: context.applicationRegistry,
    composeConfig: mode === "node",
    isRoot: options.isRoot === true,
    manifest,
    nodeExtensionScope: options.nodeExtensionScope,
    registry: context.frameworkRegistry,
  });
  const bindings: Record<string, CompiledModuleBinding> = {};
  const candidateBySourceId = new Map<string, ComposedCandidate>();
  const describeSource = (sourceId: string): ComposedSourceDescriptor | undefined => {
    const candidate = candidateBySourceId.get(sourceId);
    if (candidate === undefined) {
      return undefined;
    }
    return {
      backing: candidate.backing,
      layer: candidate.layer,
      logicalPath: candidate.logicalPath,
      owner: candidate.owner,
      sourceId: candidate.sourceId,
      sourcePath: candidate.sourcePath,
    };
  };

  // Phase one: the config slot composes and its winner loads before any
  // non-config definition. Build, task, and external-dependency settings
  // derive from the selected config.
  let config: CompiledAgentDefinition | undefined;
  if (mode === "node") {
    const configCandidate = composed.config;
    if (configCandidate === undefined || configCandidate.kind !== "config") {
      throw new Error(`Agent "${manifest.agentId}" composed no agent config source.`);
    }
    candidateBySourceId.set(configCandidate.sourceId, configCandidate);
    const hasInjectedDefinition = Object.hasOwn(options, "agentConfigDefinition");
    const definitionValue = hasInjectedDefinition
      ? options.agentConfigDefinition
      : await loadComposedModuleDefinition({
          backing: configCandidate.backing,
          displayPath: options.configDisplayPath,
          exportName: configCandidate.ref.exportName,
          extensionScopePackageNamespace: configCandidate.extensionScopePackageNamespace,
          kind: "agent config",
          logicalPath: configCandidate.logicalPath,
          registry: context.registry,
        });
    const rawConfig = await compileAgentConfig(
      {
        agentId: manifest.agentId,
        definitionValue,
        displayPath: options.configDisplayPath,
        source: configCandidate.ref,
      },
      context,
    );
    if (options.allowRootOnlyConfig === false && rawConfig.experimental?.workflow !== undefined) {
      throw new Error(
        `Workflow runtime configuration is only supported on the root agent config. Remove "experimental.workflow" from "${manifest.agentId}".`,
      );
    }
    if (options.allowRootOnlyConfig === false && rawConfig.experimental?.tasks !== undefined) {
      throw new Error(
        `Background tasks are only supported on the root agent config. Remove "experimental.tasks" from "${manifest.agentId}".`,
      );
    }
    config = rawConfig;
  }

  const externalDependencies = mergeExternalDependencies(
    options.externalDependencies,
    config?.build?.externalDependencies,
    manifest.resolvedExtensions.flatMap((mount) => mount.externalDependencies),
  );
  if (config !== undefined && externalDependencies.length > 0) {
    config = {
      ...config,
      build: {
        ...config.build,
        externalDependencies,
      },
    };
  }

  const addBinding = (candidate: ComposedCandidate): void => {
    candidateBySourceId.set(candidate.sourceId, candidate);
    const backing = candidate.backing;
    if (backing === undefined) {
      return;
    }
    bindings[candidate.sourceId] = {
      backing:
        backing.kind === "filesystem" ? { ...backing, externalDependencies } : { ...backing },
      logicalPath: candidate.logicalPath,
      owner: candidate.owner,
    };
  };
  if (config !== undefined && composed.config !== undefined) {
    addBinding(composed.config);
  }

  const load = (candidate: ComposedCandidate, kind: string): Promise<unknown> =>
    loadComposedModuleDefinition({
      backing: candidate.backing,
      exportName: (candidate.ref as { exportName?: string }).exportName,
      extensionScopePackageNamespace: candidate.extensionScopePackageNamespace,
      externalDependencies,
      kind,
      logicalPath: candidate.logicalPath,
      registry: context.registry,
    });

  // Phase two: every remaining selected winner loads through its binding
  // and normalizes with the ordinary per-primitive normalizers.
  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  let workflowTool: CompiledWorkflowToolDefinition | undefined;
  let webSearchProvider: WebSearchProvider | undefined;

  for (const candidate of composed.tools) {
    if (candidate.kind !== "tool") continue;
    const entry = compileToolEntry(candidate.ref, await load(candidate, "tool"));
    if (entry.kind === "disabled") {
      composed.composition.recordDisabled(candidate);
      continue;
    }
    if (entry.kind === "workflow-tool") {
      candidateBySourceId.set(candidate.sourceId, candidate);
      workflowTool = { maxSubagents: entry.maxSubagents };
      continue;
    }
    if (entry.kind === "web-search-tool") {
      webSearchProvider = entry.provider;
      tools.push(entry.definition);
      addBinding(candidate);
      continue;
    }
    if (entry.kind === "dynamic-tool") {
      dynamicTools.push(entry.definition);
      addBinding(candidate);
      continue;
    }
    tools.push(entry.definition);
    addBinding(candidate);
  }
  assertUniqueNames(
    tools.map((tool) => tool.name),
    "tool",
    manifest.agentId,
  );
  assertUniqueNames(
    dynamicTools.map((tool) => tool.slug),
    "dynamic tool",
    manifest.agentId,
  );

  const channels: CompiledChannelDefinition[] = [];
  for (const candidate of composed.channels) {
    if (candidate.kind !== "channel") continue;
    const result = compileChannelDefinition(candidate.ref, await load(candidate, "channel"));
    if (result.kind === "disabled") {
      composed.composition.recordDisabled(candidate);
      continue;
    }
    channels.push(...result.definitions);
    addBinding(candidate);
  }

  const connections: CompiledConnectionDefinition[] = [];
  for (const candidate of composed.connections) {
    if (candidate.kind !== "connection") continue;
    connections.push(
      compileConnectionDefinition(candidate.ref, await load(candidate, "connection")),
    );
    addBinding(candidate);
  }
  assertUniqueNames(
    connections.map((connection) => connection.connectionName),
    "connection",
    manifest.agentId,
  );

  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];
  for (const candidate of composed.skills) {
    if (candidate.kind !== "skill") continue;
    const entry =
      candidate.ref.sourceKind === "module"
        ? compileSkillSource(candidate.ref, await load(candidate, "skill"))
        : compileSkillSource(candidate.ref);
    if (entry.kind === "dynamic-skill") {
      dynamicSkills.push(entry.definition);
      addBinding(candidate);
      continue;
    }
    skills.push(withOwner(entry.definition, candidate));
    addBinding(candidate);
  }
  assertUniqueNames(
    skills.map((skill) => skill.name),
    "skill",
    manifest.agentId,
  );

  const staticInstructions: CompiledInstructionsDefinition[] = [];
  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];
  for (const candidate of composed.instructions) {
    if (candidate.kind !== "instructions") continue;
    const entry =
      candidate.ref.sourceKind === "module"
        ? compileInstructionsEntry(candidate.ref, await load(candidate, "instructions"))
        : compileInstructionsEntry(candidate.ref);
    if (entry.kind === "dynamic-instructions") {
      dynamicInstructions.push(entry.definition);
      addBinding(candidate);
      continue;
    }
    staticInstructions.push(withOwner(entry.definition, candidate));
    addBinding(candidate);
  }

  const schedules: CompiledScheduleDefinition[] = [];
  for (const candidate of composed.schedules) {
    if (candidate.kind !== "schedule") continue;
    const compiled =
      candidate.ref.sourceKind === "module"
        ? compileScheduleDefinition(candidate.ref, await load(candidate, "schedule"))
        : compileScheduleDefinition(candidate.ref);
    schedules.push(withOwner(compiled, candidate));
    addBinding(candidate);
  }
  assertUniqueNames(
    schedules.map((schedule) => schedule.name),
    "schedule",
    manifest.agentId,
  );

  const hooks: CompiledHookDefinition[] = [];
  for (const candidate of composed.hooks) {
    if (candidate.kind !== "hook") continue;
    hooks.push(compileHookEntry(candidate.ref));
    addBinding(candidate);
  }

  const sandboxCandidate = composed.sandbox;
  if (sandboxCandidate === undefined || sandboxCandidate.kind !== "sandbox") {
    throw new Error(`Agent "${manifest.agentId}" composed no sandbox source.`);
  }
  const sandboxBinding = bindingBackingFor(sandboxCandidate, externalDependencies);
  const sandbox = await compileSandboxDefinition({
    backing: sandboxBinding,
    exportValue: await load(sandboxCandidate, "sandbox"),
    source: sandboxCandidate.ref,
  });
  addBinding(sandboxCandidate);

  const extensionMounts = compileExtensionMounts(manifest);
  for (const mount of extensionMounts) {
    bindings[mount.mountSourceId] = {
      backing: {
        externalDependencies,
        kind: "filesystem",
        sourcePath: joinAgentPath(manifest.agentRoot, mount.mountLogicalPath),
      },
      logicalPath: mount.mountLogicalPath,
      owner: { kind: "application" },
    };
  }

  const selectedSubagents: SubagentSelection[] = composed.subagents.flatMap((candidate) =>
    candidate.kind === "subagent"
      ? [
          {
            candidate,
            nodeExtensionScope: resolveSubagentScope(candidate, manifest, options),
          },
        ]
      : [],
  );

  const resources: CompiledNodeResources = {
    agentRoot: manifest.agentRoot,
    appRoot: manifest.appRoot,
    channels,
    connections,
    diagnosticsSummary: manifest.diagnosticsSummary,
    dynamicInstructions,
    dynamicSkills,
    dynamicTools,
    extensionMounts,
    hooks,
    instructions: staticInstructions,
    sandbox,
    sandboxWorkspaces: manifest.sandboxWorkspaces.map((workspace) => ({
      logicalPath: workspace.logicalPath,
      rootEntries: [...workspace.rootEntries],
      sourceId: workspace.sourceId,
      sourcePath: workspace.sourcePath,
    })),
    schedules,
    skills,
    tools,
    webSearchProvider,
    workflowTool,
  };

  if (mode === "resources") {
    return {
      bindings,
      compositionState: composed.composition,
      describeSource,
      effectiveExternalDependencies: externalDependencies,
      resources,
      selectedSubagents,
    };
  }

  return {
    bindings,
    compositionState: composed.composition,
    config: config!,
    describeSource,
    effectiveExternalDependencies: externalDependencies,
    resources,
    selectedSubagents,
  };
}

/**
 * Assembles one compiled child node manifest from its parts plus the
 * subagent graph the caller compiled beneath it. Shared by the root
 * assembler and the subagent recursion.
 */
export function assembleCompiledNodeManifest(
  parts: AgentNodeParts,
  graph: {
    readonly parentScopedBindings: Readonly<Record<string, CompiledModuleBinding>>;
    readonly remoteAgents: readonly CompiledAgentManifest["remoteAgents"][number][];
  },
) {
  return createCompiledAgentNodeManifest({
    ...parts.resources,
    bindings: { ...parts.bindings, ...graph.parentScopedBindings },
    config: parts.config,
    remoteAgents: graph.remoteAgents,
    sourceComposition: parts.compositionState.toComposition(),
  });
}

function bindingBackingFor(
  candidate: ComposedCandidate,
  externalDependencies: readonly string[],
): NonNullable<ComposedCandidate["backing"]> {
  const backing = candidate.backing;
  if (backing === undefined) {
    throw new Error(`Expected a module backing for "${candidate.logicalPath}".`);
  }
  return backing.kind === "filesystem"
    ? { ...backing, externalDependencies: [...externalDependencies] }
    : backing;
}

function withOwner<T extends object>(definition: T, candidate: ComposedCandidate): T {
  if (candidate.backing !== undefined) {
    return definition;
  }
  return { ...definition, owner: candidate.owner };
}

function resolveSubagentScope(
  candidate: ComposedCandidate,
  manifest: AgentSourceManifest,
  options: CompileAgentNodePartsOptions,
): NodeExtensionScope | undefined {
  if (candidate.owner.kind !== "extension") {
    return undefined;
  }
  if (options.nodeExtensionScope !== undefined) {
    return options.nodeExtensionScope;
  }
  const mount = manifest.resolvedExtensions.find(
    (entry) => entry.namespace === (candidate.owner as { namespace: string }).namespace,
  );
  if (mount === undefined) {
    throw new Error(`Missing resolved extension mount for subagent "${candidate.logicalPath}".`);
  }
  return {
    namespace: mount.namespace,
    packageName: mount.packageName,
    packageNamespace: packageStateNamespace(mount.packageName),
    sourceRoot: mount.sourceRoot,
  };
}

function assertUniqueNames(names: readonly string[], kind: string, agentId: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(
        `Agent "${agentId}" compiled more than one ${kind} named "${name}". ` +
          `Rename one source so every ${kind} keeps a unique public identity.`,
      );
    }
    seen.add(name);
  }
}

function compileExtensionMounts(manifest: AgentSourceManifest): CompiledExtensionMount[] {
  return manifest.resolvedExtensions.map((mount) => {
    const mountRef = manifest.extensions.find(
      (entry) => mountRefNamespace(entry.logicalPath) === mount.namespace,
    );
    return {
      externalDependencies: [...mount.externalDependencies],
      namespace: mount.namespace,
      packageName: mount.packageName,
      packageNamespace: packageStateNamespace(mount.packageName),
      sourceRoot: mount.sourceRoot,
      mountSourceId: mountRef?.sourceId ?? `extensions/${mount.namespace}`,
      mountLogicalPath: mountRef?.logicalPath ?? `extensions/${mount.namespace}`,
    };
  });
}

function joinAgentPath(agentRoot: string, logicalPath: string): string {
  return join(agentRoot, logicalPath);
}

function mergeExternalDependencies(
  ...dependencyLists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const dependencies = new Set<string>();

  for (const dependencyList of dependencyLists) {
    for (const dependencyName of dependencyList ?? []) {
      dependencies.add(dependencyName);
    }
  }

  return [...dependencies];
}
