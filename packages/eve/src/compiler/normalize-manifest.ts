import type {
  AgentSourceManifest,
  ChannelSourceRef,
  ConnectionSourceRef,
  HookSourceRef,
  InstructionsSourceRef,
  LocalSubagentSourceRef,
  SandboxSourceRef,
  ScheduleSourceRef,
  SkillSourceRef,
  ToolSourceRef,
} from "#discover/manifest.js";
import {
  type CompiledAgentManifest,
  type CompiledAgentResources,
  type CompiledChannelDefinition,
  type CompiledDynamicInstructionsDefinition,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledInstructionsDefinition,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  type CompiledWebSearchProviderDefinition,
  type CompiledWorkflowToolDefinition,
  type CompiledSubagentNode,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { createCompiledChannelRoutePlan } from "#compiler/channel-route-plan.js";
import {
  createCompiledRuntimeModelCatalogLoader,
  type CompiledRuntimeModelCatalogLoader,
} from "#compiler/model-catalog.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import {
  normalizeSelectedSource,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import {
  attachRemoteSources,
  compileSubagentGraph,
  toKernelSemanticSubagentSources,
  type CompiledAgentNodeCompilation,
  type CompiledAgentResourcesCompilation,
  type SelectedSubagentSource,
} from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import {
  composeAgentSourceRegistries,
  type AgentSourceRegistry,
} from "#compiler/agent-source-registry.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import {
  composeRemainingAgentSources,
  finalizeDisabledSources,
  mergeEffectiveAgentSourceGraphs,
  prepareAgentConfigPhase,
  type AgentNodeSourceOrigin,
  type EffectiveAgentNodeSourceGraph,
  type EffectiveAgentSourceCandidate,
  type PreparedAgentConfigPhase,
} from "#compiler/effective-agent-source-graph.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import { prepareKernelCapabilityPlan } from "#kernel/capabilities.js";
import {
  getKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtRuntimeToolName,
  isKernelFrameworkSourceCapability,
  isReservedKernelCapability,
  type KernelCapabilityName,
} from "#kernel/capabilities.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";
import { summarizeCompilerDiagnostics } from "#shared/compiler-diagnostics.js";
import type { BuiltInWorkflowWorldTarget } from "#internal/workflow/world-target.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";
import { createCompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import {
  collectExternalDependencyRequests,
  mergeExternalDependencies,
  withSelectedConfigExternalDependencies,
} from "#compiler/compiled-external-dependencies.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { createCompiledInstrumentationPlan } from "#compiler/compiled-instrumentation-plan.js";
import { compileNodeExternalDependencySelection } from "#compiler/normalize-external-dependencies.js";

export interface CompileAgentManifestOptions {
  readonly defaultWorkflowWorld?: BuiltInWorkflowWorldTarget;
  readonly diagnostics?: CompilerDiagnostic[];
  /** Compiler-owned model metadata source. Tests may provide an in-memory catalog. */
  readonly modelCatalog?: CompiledRuntimeModelCatalogLoader;
  /** Application-owned programmatic sources composed with eve's immutable framework registry. */
  readonly registry?: AgentSourceRegistry;
}

/** Compiles one discovery manifest into the normalized manifest loaded by the runtime. */
export async function compileAgentManifest(
  manifest: AgentSourceManifest,
  options: CompileAgentManifestOptions = {},
): Promise<CompiledAgentManifest> {
  let workflowWorld: CompiledWorkflowWorldPlan = {
    kind: "native",
    selection: "host-default",
    target: options.defaultWorkflowWorld ?? "local",
  };
  const registry =
    options.registry === undefined
      ? frameworkAgentSourceRegistry
      : composeAgentSourceRegistries([frameworkAgentSourceRegistry, options.registry]);
  const externalDependencyPlanSession = createCompiledExternalDependencyPlanSession();
  const context: ManifestCompileContext = {
    diagnostics: options.diagnostics ?? [],
    externalDependencyPlanSession,
    modelCatalog: options.modelCatalog ?? createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
    moduleLoader: createAgentModuleNamespaceLoader({
      externalDependencyPlanSession,
      registry,
    }),
    registry,
  };
  const compiledRoot = await compileAgentNodeManifest(manifest, context, {
    allowRootOnlyConfig: true,
    isRoot: true,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    workflowWorld: {
      defaultTarget: options.defaultWorkflowWorld ?? "local",
      setPlan(plan) {
        workflowWorld = plan;
      },
    },
  });
  const subagentGraph = await compileSubagentGraph({
    appRoot: manifest.appRoot,
    compileAgentNodeManifest,
    compileAgentResources,
    context,
    externalDependencies: compiledRoot.agent.config.build?.externalDependencies ?? [],
    parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagents: compiledRoot.subagents,
  });

  const backgroundTool = [compiledRoot.agent, ...subagentGraph.nodes.map((node) => node.agent)]
    .flatMap((node) => node.tools)
    .find((tool) => tool.execution === "background");
  if (backgroundTool !== undefined && compiledRoot.agent.config.experimental?.tasks !== true) {
    throw new Error(
      `Background tool "${backgroundTool.name}" requires experimental.tasks: true in the root agent config.`,
    );
  }

  const rootAgent = attachRemoteSources(compiledRoot.agent, subagentGraph.remoteAgents, {
    isRoot: true,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagentSources: toKernelSemanticSubagentSources(compiledRoot.subagents),
  });
  const diagnosticsSummary = summarizeCompilerDiagnostics(context.diagnostics);
  const subagents = subagentGraph.nodes.map((subagent) =>
    withDiagnosticsSummary(subagent, diagnosticsSummary),
  );
  const externalDependencyPlan = await externalDependencyPlanSession.finalize(
    collectExternalDependencyRequests(rootAgent, subagents),
  );
  return createCompiledAgentManifest({
    ...rootAgent,
    diagnosticsSummary,
    externalDependencyPlan,
    subagentEdges: subagentGraph.edges,
    subagents,
    workflowWorld,
  });
}

function withDiagnosticsSummary(
  subagent: CompiledSubagentNode,
  diagnosticsSummary: ReturnType<typeof summarizeCompilerDiagnostics>,
): CompiledSubagentNode {
  if (subagent.configResolver === undefined) {
    return {
      ...subagent,
      agent: { ...subagent.agent, diagnosticsSummary },
    };
  }

  return {
    ...subagent,
    agent: { ...subagent.agent, diagnosticsSummary },
  };
}

export interface CompileAgentNodeOptions {
  readonly allowRootOnlyConfig?: boolean;
  readonly externalDependencies?: readonly string[];
  readonly isRoot: boolean;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
  readonly preparedConfig?: PreparedAgentConfigPhase;
  readonly workflowWorld?: {
    readonly defaultTarget: BuiltInWorkflowWorldTarget;
    readonly setPlan: (plan: CompiledWorkflowWorldPlan) => void;
  };
}

export async function compileAgentNodeManifest(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentNodeOptions,
): Promise<CompiledAgentNodeCompilation> {
  const nodeId = options.nodeId;
  const discoveryDependencies = mergeExternalDependencies(options.externalDependencies);
  const preparedConfig =
    options.preparedConfig ??
    (await prepareAgentConfigPhase({
      context,
      externalDependencies: discoveryDependencies,
      isRoot: options.isRoot,
      manifest,
      nodeId,
      origin: options.origin,
    }));
  const selectedConfigManifest: AgentSourceManifest = { ...manifest };
  selectedConfigManifest.configModule = preparedConfig.candidate.source as NonNullable<
    typeof manifest.configModule
  >;
  const config = await normalizeSelectedSource(
    toCandidateNormalizationSource(preparedConfig.candidate, preparedConfig.binding),
    async () => {
      const compiled = await compileAgentConfig(selectedConfigManifest, context, {
        allowWorkflowRuntime: options.allowRootOnlyConfig ?? false,
        binding: preparedConfig.binding,
        definition: preparedConfig.definition,
        workflowWorld: options.workflowWorld,
      });
      assertRootOnlyConfig(compiled, manifest, options.allowRootOnlyConfig ?? false);
      return compiled;
    },
  );
  const externalDependencies = mergeExternalDependencies(
    options.externalDependencies,
    config.build?.externalDependencies,
  );
  const configGraph = withSelectedConfigExternalDependencies(
    preparedConfig.graph,
    preparedConfig.candidate.descriptor.sourceId,
    externalDependencies,
  );
  if (
    options.isRoot === true &&
    config.experimental?.instrumentationProviders === true &&
    manifest.instrumentation.file !== undefined
  ) {
    throw new Error(
      `Found "${manifest.instrumentation.file.logicalPath}", but \`experimental.instrumentationProviders\` is on. Move it into the "instrumentation/" directory as one file per provider.`,
    );
  }
  const compilation = await compileAgentResources(manifest, context, {
    additionalConfigReference: config.source,
    configGraph,
    declaredExternalDependencies: config.build?.externalDependencies ?? [],
    externalDependencies,
    instrumentationProvidersEnabled: config.experimental?.instrumentationProviders === true,
    isRoot: options.isRoot,
    nodeId,
    origin: options.origin,
    tasksEnabled: config.experimental?.tasks === true,
  });
  return {
    agent: createCompiledAgentNodeManifest(
      { ...compilation.resources, config },
      {
        isRoot: options.isRoot === true,
        nodeId,
        subagentSources: toKernelSemanticSubagentSources(compilation.subagents),
      },
    ),
    subagents: compilation.subagents,
  };
}

export interface CompileAgentResourcesOptions {
  readonly additionalConfigReference?: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly sourceKind: "module";
  };
  readonly configGraph: EffectiveAgentNodeSourceGraph;
  readonly declaredExternalDependencies: readonly string[];
  readonly externalDependencies?: readonly string[];
  readonly isRoot: boolean;
  readonly instrumentationProvidersEnabled?: boolean;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
  readonly tasksEnabled?: boolean;
}

export async function compileAgentResources(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentResourcesOptions,
): Promise<CompiledAgentResourcesCompilation> {
  const externalDependencies = [...(options.externalDependencies ?? [])];
  const remainingGraph = composeRemainingAgentSources({
    externalDependencies,
    instrumentationProvidersEnabled: options.instrumentationProvidersEnabled ?? false,
    isRoot: options.isRoot,
    manifest,
    nodeId: options.nodeId,
    origin: options.origin,
    registry: context.registry,
  });
  let graph = mergeEffectiveAgentSourceGraphs(options.configGraph, remainingGraph);
  const { extensionMounts, requests: externalDependencyRequests } =
    compileNodeExternalDependencySelection({
      declaredExternalDependencies: options.declaredExternalDependencies,
      graph,
      manifest,
      nodeId: options.nodeId,
      origin: options.origin,
    });
  await context.externalDependencyPlanSession.register(externalDependencyRequests);
  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledKernelCapabilities = new Set<KernelCapabilityName>();
  const replacedKernelCapabilities = new Set<KernelCapabilityName>();
  let frameworkLoadSkill = false;
  const channelCandidates: CompiledChannelDefinition[] = [];
  const connections: CompiledAgentResources["connections"][number][] = [];
  const hooks: CompiledAgentResources["hooks"][number][] = [];
  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];
  const instructions: CompiledInstructionsDefinition[] = [];
  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];
  const schedules: CompiledAgentResources["schedules"][number][] = [];
  const disabledSourceIds = new Set<string>();
  let sandbox: CompiledAgentResources["sandbox"] | undefined;
  let workflowTool: CompiledWorkflowToolDefinition | undefined;
  let webSearchProvider: CompiledWebSearchProviderDefinition | undefined;

  for (const candidate of graph.winners) {
    if (candidate.kind === "config" || candidate.kind === "extension-mount") continue;
    if (candidate.kind === "subagent" && candidate.publicName !== undefined) {
      const replacement = getReplaceableKernelCapabilityAtRuntimeToolName(candidate.publicName);
      if (replacement !== undefined) replacedKernelCapabilities.add(replacement);
    }
    const binding = graph.bindings[candidate.descriptor.sourceId];
    const namingOptions: { name?: string } = {};
    if (candidate.publicName !== undefined) namingOptions.name = candidate.publicName;
    const moduleOptions =
      binding === undefined
        ? undefined
        : { binding, moduleLoader: context.moduleLoader, ...namingOptions };

    await normalizeSelectedSource(toCandidateNormalizationSource(candidate, binding), async () => {
      switch (candidate.kind) {
        case "channel": {
          const result = await compileChannelDefinition(
            candidate.source as ChannelSourceRef,
            requireModuleOptions(candidate, moduleOptions),
          );
          const entries = Array.isArray(result) ? result : [result];
          if (entries[0]?.kind === "disabled") {
            disabledSourceIds.add(candidate.descriptor.sourceId);
          } else {
            channelCandidates.push(...(entries as CompiledChannelDefinition[]));
          }
          break;
        }
        case "connection":
          connections.push(
            await compileConnectionDefinition(
              candidate.source as ConnectionSourceRef,
              requireModuleOptions(candidate, moduleOptions),
            ),
          );
          break;
        case "hook":
          hooks.push(
            await compileHookEntry(candidate.source as HookSourceRef, {
              ...requireModuleOptions(candidate, moduleOptions),
              slug: candidate.publicName,
            }),
          );
          break;
        case "instrumentation":
          break;
        case "instructions": {
          const source = candidate.source as InstructionsSourceRef;
          const entry = await (source.sourceKind === "module"
            ? compileInstructionsEntry(source, requireModuleOptions(candidate, moduleOptions))
            : compileInstructionsEntry(source, namingOptions));
          if (entry.kind === "instructions") instructions.push(entry.definition);
          else dynamicInstructions.push(entry.definition);
          break;
        }
        case "sandbox": {
          const required = requireModuleOptions(candidate, moduleOptions);
          sandbox = await compileSandboxDefinition(candidate.source as SandboxSourceRef, {
            ...required,
            externalDependencyPlan: context.externalDependencyPlanSession.planFor(
              required.binding.backing.kind === "filesystem"
                ? externalDependencyPlanPackageNames(required.binding.backing.externalDependencies)
                : [],
            ),
          });
          break;
        }
        case "schedule":
          {
            const source = candidate.source as ScheduleSourceRef;
            schedules.push(
              await (source.sourceKind === "module"
                ? compileScheduleDefinition(source, requireModuleOptions(candidate, moduleOptions))
                : compileScheduleDefinition(source, namingOptions)),
            );
          }
          break;
        case "skill": {
          const source = candidate.source as SkillSourceRef;
          const entry = await (source.sourceKind === "module"
            ? compileSkillSource(source, requireModuleOptions(candidate, moduleOptions))
            : compileSkillSource(source, namingOptions));
          if (entry.kind === "skill") skills.push(entry.definition);
          else dynamicSkills.push(entry.definition);
          break;
        }
        case "tool": {
          const kernelCapability = getKernelCapabilityAtPath(candidate.descriptor.logicalPath);
          if (kernelCapability !== undefined && isReservedKernelCapability(kernelCapability)) {
            throw new Error(
              `The source "${candidate.descriptor.logicalPath}" occupies the reserved ${kernelCapability} kernel slot and cannot replace its native lifecycle.`,
            );
          }
          const entry = await compileToolEntry(
            candidate.source as ToolSourceRef,
            requireModuleOptions(candidate, moduleOptions),
          );
          if (entry.kind === "tool") {
            tools.push(entry.definition);
            if (kernelCapability !== undefined && candidate.descriptor.owner.kind !== "framework") {
              replacedKernelCapabilities.add(kernelCapability);
            }
            if (
              kernelCapability !== undefined &&
              isKernelFrameworkSourceCapability(kernelCapability) &&
              candidate.descriptor.owner.kind === "framework"
            ) {
              frameworkLoadSkill = true;
            }
          } else if (entry.kind === "dynamic-tool") {
            dynamicTools.push(
              candidate.namespace === undefined
                ? entry.definition
                : { ...entry.definition, extensionNamespace: candidate.namespace },
            );
            if (kernelCapability !== undefined && candidate.descriptor.owner.kind !== "framework") {
              replacedKernelCapabilities.add(kernelCapability);
            }
          } else if (entry.kind === "workflow-tool") {
            assertApplicationOwnedSpecialTool(candidate, "the Workflow tool");
            workflowTool = entry.definition;
          } else if (entry.kind === "web-search-tool") {
            assertApplicationOwnedSpecialTool(candidate, "web search");
            webSearchProvider = entry.definition;
          } else {
            disabledSourceIds.add(candidate.descriptor.sourceId);
            const hasLowerPrecedenceSource = graph.composition.shadowed.some(
              (source) =>
                source.slot === candidate.slot &&
                source.winningSourceId === candidate.descriptor.sourceId,
            );
            const replaceableKernelCapability = getReplaceableKernelCapabilityAtPath(
              candidate.descriptor.logicalPath,
            );
            if (
              !hasLowerPrecedenceSource &&
              candidate.descriptor.owner.kind === "application" &&
              replaceableKernelCapability !== undefined
            ) {
              disabledKernelCapabilities.add(replaceableKernelCapability);
            }
          }
          break;
        }
        case "subagent":
        case "workspace":
          break;
      }
    });
  }

  assertUniqueToolNames(tools, dynamicTools);
  if (sandbox === undefined) {
    throw new Error(
      `Agent node "${options.nodeId}" has no selected sandbox source after composition.`,
    );
  }
  graph = finalizeDisabledSources(graph, disabledSourceIds);
  const channelRoutes = createCompiledChannelRoutePlan({
    bindings: graph.bindings,
    diagnostics: context.diagnostics,
    nodeId: options.nodeId,
    routes: channelCandidates,
  });
  const resourceInput = {
    agentRoot: manifest.agentRoot,
    appRoot: manifest.appRoot,
    bindings: graph.bindings,
    channelRoutes,
    connections,
    diagnosticsSummary: summarizeCompilerDiagnostics(context.diagnostics),
    kernelPlan: prepareKernelCapabilityPlan({
      disabled: disabledKernelCapabilities,
      frameworkLoadSkill,
      hasSkills: skills.length > 0 || dynamicSkills.length > 0,
      isRoot: options.isRoot,
      replaced: replacedKernelCapabilities,
      tasksEnabled: options.tasksEnabled === true,
      webSearch: webSearchProvider !== undefined,
      workflow: workflowTool !== undefined,
    }),
    workflowTool,
    webSearchProvider,
    dynamicInstructions,
    dynamicSkills,
    dynamicTools,
    extensionMounts,
    hooks,
    instrumentation: await createCompiledInstrumentationPlan({
      graph,
      isRoot: options.isRoot,
      providersEnabled: options.instrumentationProvidersEnabled === true,
    }),
    instructions,
    remoteAgents: [],
    sandbox,
    sandboxWorkspaces: graph.winners
      .filter((candidate) => candidate.kind === "workspace")
      .map((candidate) => {
        const source = candidate.source as AgentSourceManifest["sandboxWorkspaces"][number];
        return {
          logicalPath: source.logicalPath,
          rootEntries: [...source.rootEntries],
          sourceId: source.sourceId,
          sourcePath: source.sourcePath,
        };
      }),
    schedules,
    skills,
    sourceComposition: graph.composition,
    tools,
  };
  const subagents = selectSubagentSources(graph);
  return {
    resources: createCompiledAgentResources(resourceInput, {
      additionalBindingReferences:
        options.additionalConfigReference === undefined ? [] : [options.additionalConfigReference],
      isRoot: options.isRoot,
      nodeId: options.nodeId,
      subagentSources: toKernelSemanticSubagentSources(subagents),
      tasksEnabled: options.tasksEnabled,
    }),
    subagents,
  };
}

function selectSubagentSources(graph: EffectiveAgentNodeSourceGraph): SelectedSubagentSource[] {
  return graph.winners.flatMap((candidate) =>
    candidate.kind === "subagent"
      ? [{ candidate, source: candidate.source as LocalSubagentSourceRef }]
      : [],
  );
}

interface RequiredModuleOptions {
  readonly binding: CompiledModuleBinding;
  readonly moduleLoader: ManifestCompileContext["moduleLoader"];
  readonly name?: string;
}

function requireModuleOptions(
  candidate: EffectiveAgentSourceCandidate,
  options: RequiredModuleOptions | undefined,
): RequiredModuleOptions {
  if (options === undefined) {
    throw new Error(
      `Selected module source "${candidate.descriptor.sourceId}" is missing its binding before normalization.`,
    );
  }
  return options;
}

function toCandidateNormalizationSource(
  candidate: EffectiveAgentSourceCandidate,
  binding: CompiledModuleBinding | undefined,
): {
  readonly kind: string;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly sourcePath?: string;
} {
  const descriptorBacking =
    "backing" in candidate.descriptor ? candidate.descriptor.backing : undefined;
  const backing = binding?.backing ?? descriptorBacking;
  const sourcePath =
    backing?.kind === "filesystem"
      ? backing.sourcePath
      : "sourcePath" in candidate.source && typeof candidate.source.sourcePath === "string"
        ? candidate.source.sourcePath
        : undefined;
  const source = {
    kind: candidate.kind === "config" ? "agent config" : candidate.kind,
    logicalPath: candidate.descriptor.logicalPath,
    nodeId: candidate.nodeId,
    sourceId: candidate.descriptor.sourceId,
  };
  return sourcePath === undefined ? source : { ...source, sourcePath };
}

function assertApplicationOwnedSpecialTool(
  candidate: EffectiveAgentSourceCandidate,
  feature: string,
): void {
  if (candidate.namespace !== undefined) {
    throw new Error(
      `The extension source "${candidate.descriptor.logicalPath}" configures ${feature}, but that capability belongs to the consuming application.`,
    );
  }
}

function assertUniqueToolNames(
  tools: readonly CompiledToolDefinition[],
  dynamicTools: readonly CompiledDynamicToolDefinition[],
): void {
  const names = new Map<string, string>();
  const entries = [
    ...tools.map((tool) => ({ logicalPath: tool.logicalPath, name: tool.name })),
    ...dynamicTools.map((tool) => ({ logicalPath: tool.logicalPath, name: tool.slug })),
  ];
  for (const tool of entries) {
    const previous = names.get(tool.name);
    if (previous !== undefined && previous !== tool.logicalPath) {
      throw new Error(
        `Tool sources "${previous}" and "${tool.logicalPath}" both flatten to public name "${tool.name}". Rename one source so every logical slot has a unique tool name.`,
      );
    }
    names.set(tool.name, tool.logicalPath);
  }
}

function assertRootOnlyConfig(
  config: Awaited<ReturnType<typeof compileAgentConfig>>,
  manifest: AgentSourceManifest,
  allowRootOnlyConfig: boolean,
): void {
  if (allowRootOnlyConfig) return;
  if (config.experimental?.tasks !== undefined) {
    throw new Error(
      `Background tasks are only supported on the root agent config. Remove "experimental.tasks" from "${manifest.agentId}".`,
    );
  }
  if (config.experimental?.instrumentationProviders !== undefined) {
    throw new Error(
      `Instrumentation providers are only supported on the root agent config. Remove "experimental.instrumentationProviders" from "${manifest.agentId}".`,
    );
  }
}
