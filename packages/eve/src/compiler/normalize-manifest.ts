import { randomUUID } from "node:crypto";
import type { ExtensionCompileMount } from "#compiler/load-binding-namespace.js";
import { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";
import { assertStaticConnectionOwnership } from "#compiler/connection-ownership.js";
import {
  createAuthoredModuleGraph,
  type AuthoredModuleGraph,
} from "#internal/authored-module-graph.js";
import { bindingMountId } from "#compiler/extension-mount-bindings.js";

import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  type CompiledAgentDefinition,
  type CompiledAgentManifest,
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledChannelDefinition,
  type CompiledConnectionDefinition,
  type CompiledDynamicConnectionDefinition,
  type CompiledDynamicInstructionsDefinition,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledInstructionsDefinition,
  type CompiledMemoryDefinition,
  type CompiledHookDefinition,
  type CompiledRemoteAgentNode,
  type CompiledSkillDefinition,
  type CompiledScheduleCollectionDefinition,
  type CompiledScheduleDefinition,
  type CompiledSandboxDefinition,
  type CompiledSubagentNode,
  type CompiledToolDefinition,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { markConfigRuntimeEntries } from "#compiler/module-lifecycle.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import {
  applyAgentToolPolicy,
  applyDefaultToolPolicy,
  canDisableToolWithoutSelectedSource,
} from "#compiler/default-tool-policy.js";
import {
  loadModuleBackedDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
import { resolveWorkspaceSubagentDefinition } from "#compiler/resolve-workspace-subagent.js";
import { workspaceSubagentName } from "#public/definitions/workspace-agent.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileMemoryDefinition } from "#compiler/normalize-memory.js";
import { createMemoryWrapperCandidates } from "#compiler/memory-wrapper-candidates.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileScheduleCollectionDefinition } from "#compiler/normalize-schedule-collection.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";
import { createScheduleCollectionWrapperCandidates } from "#compiler/schedule-collection-wrapper-candidates.js";
import { assertSkillNameAvailable, compileSkillSource } from "#compiler/normalize-skill.js";
import {
  assertRemoteAgentDefinitionHasNoLocalPackageEntries,
  normalizeSubagentConfig,
} from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import {
  finalizeNodeSourceState,
  type ComposedNodeSourceGraph,
  type FinalizedNodeSourceState,
  type PhaseOneNodeSourceState,
} from "#compiler/node-source-state.js";
import {
  assertApplicationOverlayCanApplyToAllNodes,
  assertNonExtensionSpecialTool,
  assertRootOnlyConfig,
  assertUniqueBy,
  assertUniqueRegistryIds,
  compileExtensionMounts,
  compileChannelRoutes,
  createExtensionCompileMounts,
  createCompiledRemoteAgent,
  expectSubagentDescription,
  mergeExternalDependencies,
  loadSelectedNodeConfig,
  collectSelectedSourceIds,
  withDiagnosticsSummary,
  withExtensionNamespace,
} from "#compiler/normalize-manifest-helpers.js";
import { summarizeCompilerDiagnostics, type CompilerDiagnostic } from "#compiler/diagnostics.js";
import {
  listApplicationModulePaths,
  projectAgentSources,
  projectSelectedSources,
} from "#compiler/project-sources.js";
import {
  composeAgentModuleCandidates,
  createAgentModuleBinding,
  createProgrammaticModuleCandidates,
  disableComposedCandidate,
  isAgentModuleCandidate,
  type AgentModuleCandidate,
  type AgentSourceCandidate,
  type AgentSourceRegistry,
} from "#compiler/source-graph.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";
import {
  noDevelopmentExtensions,
  prepareDevelopmentExtensions,
} from "#compiler/development-extensions.js";
import type {
  CompileAgentManifestOptions,
  NodeCompileInput,
} from "#compiler/normalize-manifest-types.js";
export type { CompileAgentManifestOptions } from "#compiler/normalize-manifest-types.js";

interface CompiledLocalNodeResult {
  readonly descendants: readonly CompiledSubagentNode[];
  readonly manifest: CompiledAgentNodeManifest;
}

export async function compileAgentManifest(
  manifest: AgentSourceManifest,
  options: CompileAgentManifestOptions = {},
): Promise<CompiledAgentManifest> {
  const registries = [frameworkAgentSourceRegistry, ...(options.sourceRegistries ?? [])];
  assertUniqueRegistryIds(registries);
  const context: ManifestCompileContext = {
    modelCatalog: createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
    registries,
  };
  const diagnostics = options.diagnostics ?? [];
  const developmentExtensions = await prepareDevelopmentExtensions({
    diagnostics,
    manifest,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    selection: options.developmentExtensions ?? noDevelopmentExtensions(),
  });
  const compiler = new AgentGraphCompiler(
    context,
    registries,
    diagnostics,
    createAuthoredModuleGraph(listApplicationModulePaths(developmentExtensions.manifest), {
      appRoot: manifest.appRoot,
    }),
  );
  const root = await compiler.compileStaticNode({
    developmentExtensionCandidates: developmentExtensions.candidates,
    inheritedExternalDependencies: [],
    isRoot: true,
    layer: "application",
    manifest: developmentExtensions.manifest,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    nodePath: "",
    owner: { kind: "application" },
  });

  const diagnosticsSummary = summarizeCompilerDiagnostics(diagnostics);
  const subagents = withDiagnosticsSummary(root.descendants, diagnosticsSummary);
  return createCompiledAgentManifest({
    ...root.manifest,
    diagnosticsSummary,
    subagents,
  });
}

class AgentGraphCompiler {
  private readonly context: ManifestCompileContext;
  private readonly registries: readonly AgentSourceRegistry[];
  private readonly diagnostics: CompilerDiagnostic[];
  private readonly mounts = new Map<string, ExtensionCompileMount>();
  private readonly evaluationId = randomUUID();
  private readonly moduleGraph: AuthoredModuleGraph;

  constructor(
    context: ManifestCompileContext,
    registries: readonly AgentSourceRegistry[],
    diagnostics: CompilerDiagnostic[],
    moduleGraph: AuthoredModuleGraph,
  ) {
    this.context = context;
    this.registries = registries;
    this.diagnostics = diagnostics;
    this.moduleGraph = moduleGraph;
  }

  async compileStaticNode(input: NodeCompileInput): Promise<CompiledLocalNodeResult> {
    const phaseOne = await this.createPhaseOneNodeSourceState(
      input,
      input.inheritedExternalDependencies,
    );
    let config = await compileAgentConfig(input.manifest, this.context, {
      binding: phaseOne.selectedConfig.binding,
      definition: phaseOne.selectedConfig.definition,
      source: phaseOne.selectedConfig.source,
    });
    assertRootOnlyConfig(config, input.isRoot, input.manifest.agentId);
    applyAgentToolPolicy(phaseOne, config);
    applyDefaultToolPolicy(phaseOne, config);

    const externalDependencies = mergeExternalDependencies(
      input.inheritedExternalDependencies,
      config.build?.externalDependencies,
      input.manifest.resolvedExtensions.flatMap((mount) => mount.externalDependencies),
    );
    if (externalDependencies.length > 0) {
      config = {
        ...config,
        build: { ...config.build, externalDependencies },
      };
    }
    const state = finalizeNodeSourceState(phaseOne, externalDependencies);
    markConfigRuntimeEntries(config, state.evaluation);
    const resources = await this.compileResources(input, state);
    const children = await this.compileChildren(input, state, externalDependencies);
    const manifest = createCompiledAgentNodeManifest({
      ...resources,
      config,
      remoteAgents: children.remoteAgents,
    });
    return {
      descendants: children.nodes,
      manifest,
    };
  }

  private async compileChildren(
    input: NodeCompileInput,
    state: FinalizedNodeSourceState,
    inheritedExternalDependencies: readonly string[],
  ): Promise<{
    readonly nodes: readonly CompiledSubagentNode[];
    readonly remoteAgents: readonly CompiledRemoteAgentNode[];
  }> {
    const nodes: CompiledSubagentNode[] = [];
    const remoteAgents: CompiledRemoteAgentNode[] = [];
    const selectedSourceIds = collectSelectedSourceIds(state.composed);
    const subagents = state.projected.subagents.filter((source) =>
      selectedSourceIds.has(source.candidate.sourceId),
    );
    for (const projected of subagents) {
      const source = projected.source;
      const nodeId = createCompiledSubagentNodeId(input.nodeId, source.sourceId);
      const childInput: NodeCompileInput = {
        extensionScope: projected.extensionScope ?? input.extensionScope,
        mountId: projected.mountId,
        inheritedExternalDependencies,
        isRoot: false,
        layer: projected.candidate.layer,
        manifest: source.manifest,
        nodeId,
        nodePath: projected.nodePath,
        owner: projected.owner,
        parentNodeId: input.nodeId,
      };
      const phaseOne = await this.createPhaseOneNodeSourceState(
        childInput,
        inheritedExternalDependencies,
      );
      const normalized = normalizeSubagentConfig(
        phaseOne.selectedConfig.definition,
        `Expected the subagent config export "${phaseOne.selectedConfig.source.exportName ?? "default"}" from "${source.entryPath}" to match the public eve shape.`,
      );

      if (normalized.kind === "remote") {
        const workspaceName = workspaceSubagentName(phaseOne.selectedConfig.definition);
        const remoteDefinition =
          workspaceName === undefined
            ? normalized
            : await resolveWorkspaceSubagentDefinition({
                definition: normalized,
                name: workspaceName,
                registries: this.registries,
                source,
              });
        assertRemoteAgentDefinitionHasNoLocalPackageEntries(source);
        const sourceId = phaseOne.selectedConfig.source.sourceId;
        phaseOne.evaluation.setBindings({ [sourceId]: phaseOne.selectedConfig.binding });
        phaseOne.evaluation.requireRuntimeEntry(sourceId);
        const binding = phaseOne.evaluation.finalizeBindings()[sourceId];
        if (binding === undefined) {
          throw new Error(`Remote subagent "${nodeId}" has no finalized config binding.`);
        }
        remoteAgents.push(
          createCompiledRemoteAgent({
            binding,
            definition: remoteDefinition,
            nodeId,
            owner: projected.owner,
            parentNodeId: input.nodeId,
            source,
            sourceRef: phaseOne.selectedConfig.source,
          }),
        );
        continue;
      }

      let config: CompiledAgentDefinition | undefined;
      let dynamicBuildDependencies: readonly string[] | undefined;
      if (normalized.kind === "local") {
        config = await compileAgentConfig(source.manifest, this.context, {
          binding: phaseOne.selectedConfig.binding,
          definition: normalized.definition,
          source: phaseOne.selectedConfig.source,
        });
        assertRootOnlyConfig(config, false, source.manifest.agentId);
        applyAgentToolPolicy(phaseOne, config);
        applyDefaultToolPolicy(phaseOne, config);
      } else {
        dynamicBuildDependencies = normalized.build?.externalDependencies;
      }
      const externalDependencies = mergeExternalDependencies(
        inheritedExternalDependencies,
        config?.build?.externalDependencies,
        dynamicBuildDependencies,
        source.manifest.resolvedExtensions.flatMap((mount) => mount.externalDependencies),
      );
      if (config !== undefined && externalDependencies.length > 0) {
        config = { ...config, build: { ...config.build, externalDependencies } };
      }
      const finalState = finalizeNodeSourceState(phaseOne, externalDependencies);
      if (config === undefined) {
        finalState.evaluation.requireRuntimeEntry(phaseOne.selectedConfig.source.sourceId);
      } else {
        markConfigRuntimeEntries(config, finalState.evaluation);
      }
      const resources = await this.compileResources(childInput, finalState);
      const children = await this.compileChildren(childInput, finalState, externalDependencies);
      const base = {
        backing: projected.candidate.backing,
        entryPath: source.entryPath,
        logicalPath: source.logicalPath,
        name: source.subagentId,
        nodeId,
        owner: projected.owner,
        parentNodeId: input.nodeId,
        rootPath: source.rootPath,
        sourceId: source.sourceId,
        sourceKind: "module" as const,
      };
      let node: CompiledSubagentNode;
      if (config === undefined) {
        node = {
          ...base,
          agent: createCompiledAgentResources({
            ...resources,
            remoteAgents: children.remoteAgents,
          }),
          configResolver: {
            build: normalized.kind === "dynamic" ? normalized.build : undefined,
            eventNames: normalized.kind === "dynamic" ? normalized.eventNames : [],
            exportName: phaseOne.selectedConfig.source.exportName,
            logicalPath: phaseOne.selectedConfig.source.logicalPath,
            sourceId: phaseOne.selectedConfig.source.sourceId,
            sourceKind: "module",
          },
        };
      } else {
        node = {
          ...base,
          agent: createCompiledAgentNodeManifest({
            ...resources,
            config,
            remoteAgents: children.remoteAgents,
          }),
          description: expectSubagentDescription(config, source),
        };
      }
      nodes.push(node, ...children.nodes);
    }

    return { nodes, remoteAgents };
  }

  private composeNodeSources(
    input: NodeCompileInput,
    externalDependencies: readonly string[],
  ): ComposedNodeSourceGraph {
    const projected = projectAgentSources({
      externalDependencies,
      extensionScope: input.extensionScope,
      mountId: input.mountId,
      layer: input.layer,
      manifest: input.manifest,
      nodeId: input.nodeId,
      nodePath: input.nodePath,
      owner: input.owner,
    });
    const frameworkCandidates: AgentModuleCandidate[] = [];
    const applicationCandidates: AgentModuleCandidate[] = [];
    for (const registry of this.registries) {
      const framework = registry === frameworkAgentSourceRegistry;
      for (const registration of registry.registrations) {
        if (registration.applyTo === "root" && !input.isRoot) continue;
        if (!framework && registration.applyTo === "all-local-nodes") {
          assertApplicationOverlayCanApplyToAllNodes(
            registration.source.modules.map((m) => m.logicalPath),
          );
        }
        const candidates = createProgrammaticModuleCandidates({
          layer: framework ? "framework-default" : "application",
          nodeId: input.nodeId,
          owner: framework
            ? { feature: registration.source.id, kind: "framework" }
            : { kind: "application" },
          registration,
        });
        (framework ? frameworkCandidates : applicationCandidates).push(...candidates);
      }
    }
    const orderedCandidates: AgentSourceCandidate[] = [
      ...frameworkCandidates,
      ...(input.developmentExtensionCandidates ?? []),
      ...projected.candidates,
      ...createMemoryWrapperCandidates([...projected.candidates, ...applicationCandidates]),
      ...createScheduleCollectionWrapperCandidates(
        [...projected.candidates, ...applicationCandidates],
        input.manifest.agentId,
      ),
      ...applicationCandidates,
    ];
    const composed = composeAgentModuleCandidates(orderedCandidates);
    const sources = projectSelectedSources({
      candidates: composed.selected.values(),
      resources: projected.resources,
    });
    return {
      composed,
      orderedCandidates,
      projected,
      sourcesBySourceId: new Map(sources.map((entry) => [entry.candidate.sourceId, entry])),
      subagentsBySourceId: new Map(
        projected.subagents.map((entry) => [entry.candidate.sourceId, entry]),
      ),
    };
  }

  private async createPhaseOneNodeSourceState(
    input: NodeCompileInput,
    externalDependencies: readonly string[],
  ): Promise<PhaseOneNodeSourceState> {
    const graph = this.composeNodeSources(input, externalDependencies);
    const { mounts, sourceIds } = createExtensionCompileMounts(input.manifest, input.nodePath);
    for (const [mountId, mount] of mounts) this.mounts.set(mountId, mount);
    const evaluation = new NodeModuleEvaluationContext(
      this.registries,
      (binding) => sourceIds.get(bindingMountId(binding) ?? ""),
      this.mounts,
      this.evaluationId,
      input.manifest.appRoot,
      this.moduleGraph,
    );
    evaluation.setBindings(
      Object.fromEntries(
        [...graph.composed.selected.values()]
          .filter(isAgentModuleCandidate)
          .map((candidate) => [candidate.sourceId, createAgentModuleBinding(candidate)]),
      ),
    );
    return {
      evaluation,
      graph,
      selectedConfig: await loadSelectedNodeConfig(graph, evaluation),
    };
  }

  private async compileResources(
    input: NodeCompileInput,
    state: FinalizedNodeSourceState,
  ): Promise<CompiledAgentResources> {
    const tools: CompiledToolDefinition[] = [];
    const dynamicTools: CompiledDynamicToolDefinition[] = [];
    const skills: CompiledSkillDefinition[] = [];
    const dynamicSkills: CompiledDynamicSkillDefinition[] = [];
    const instructions: CompiledInstructionsDefinition[] = [];
    const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];
    const connections: CompiledConnectionDefinition[] = [];
    const dynamicConnections: CompiledDynamicConnectionDefinition[] = [];
    const memories: CompiledMemoryDefinition[] = [];
    const hooks: CompiledHookDefinition[] = [];
    const schedules: CompiledScheduleDefinition[] = [];
    const scheduleCollections: CompiledScheduleCollectionDefinition[] = [];
    const channels: CompiledChannelDefinition[] = [];
    let sandbox: CompiledSandboxDefinition | undefined;
    const selectedSourceIds = collectSelectedSourceIds(state.composed);
    const loadNamespace = state.evaluation.loadNamespace;

    for (const candidate of state.orderedCandidates) {
      if (!selectedSourceIds.has(candidate.sourceId)) continue;
      const entry = state.sourcesBySourceId.get(candidate.sourceId);
      if (entry === undefined) continue;
      const binding = state.bindings[candidate.sourceId];
      const options = {
        binding,
        loadNamespace,
        owner: candidate.owner,
      };
      switch (entry.kind) {
        case "config":
        case "extension":
          break;
        case "channel": {
          const result = await compileChannelDefinition(input.manifest.agentRoot, entry.source, {
            binding: binding!,
            loadNamespace,
          });
          if (result.kind === "disabled") {
            state.composed = disableComposedCandidate({ candidate, composed: state.composed });
            delete state.bindings[candidate.sourceId];
            selectedSourceIds.delete(candidate.sourceId);
          } else channels.push(...result.definitions);
          break;
        }
        case "connection": {
          const result = await compileConnectionDefinition(input.manifest.agentRoot, entry.source, {
            binding: binding!,
            loadNamespace,
          });
          if (result.kind === "connection") connections.push(result.definition);
          else {
            dynamicConnections.push(withExtensionNamespace(result.definition, candidate.owner));
          }
          state.evaluation.requireRuntimeEntry(candidate.sourceId);
          break;
        }
        case "hook":
          hooks.push(
            await compileHookEntry(entry.source, {
              binding: binding!,
              loadNamespace,
            }),
          );
          state.evaluation.requireRuntimeEntry(candidate.sourceId);
          break;
        case "instructions": {
          const result = await compileInstructionsEntry(
            input.manifest.agentRoot,
            entry.source,
            options,
          );
          if (result.kind === "instructions") instructions.push(result.definition);
          else {
            dynamicInstructions.push(result.definition);
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
          }
          break;
        }
        case "memory":
          memories.push(
            await compileMemoryDefinition(entry.source, {
              binding: binding!,
              loadNamespace,
            }),
          );
          state.evaluation.requireRuntimeEntry(candidate.sourceId);
          break;
        case "sandbox":
          sandbox = await compileSandboxDefinition(input.manifest.agentRoot, entry.source, {
            binding: binding!,
            loadNamespace,
          });
          if (!sandbox.inheritsParent) {
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
          }
          break;
        case "schedule": {
          const value =
            entry.source.sourceKind === "module"
              ? await loadModuleBackedDefinition({
                  binding: binding!,
                  loadNamespace,
                  kind: "schedule",
                  source: entry.source,
                })
              : entry.source.definition;
          if (isScheduleCollectionDefinition(value)) {
            scheduleCollections.push(compileScheduleCollectionDefinition(entry.source, value));
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
            break;
          }
          const schedule = compileScheduleDefinition(
            input.manifest.agentRoot,
            entry.source,
            value,
            options.owner,
          );
          schedules.push(schedule);
          if (schedule.sourceKind === "module" && schedule.hasRun) {
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
          }
          break;
        }
        case "skill": {
          const result = await compileSkillSource(input.manifest.agentRoot, entry.source, options);
          if (result.kind === "skill") {
            assertSkillNameAvailable(result.definition);
            skills.push(result.definition);
          } else {
            dynamicSkills.push(withExtensionNamespace(result.definition, candidate.owner));
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
          }
          break;
        }
        case "tool": {
          const result = await compileToolEntry(input.manifest.agentRoot, entry.source, {
            binding: binding!,
            loadNamespace,
          });
          if (result.kind === "disabled") {
            state.composed = disableComposedCandidate({
              allowUnmatched: canDisableToolWithoutSelectedSource(state, result.name),
              candidate,
              composed: state.composed,
            });
            delete state.bindings[candidate.sourceId];
            selectedSourceIds.delete(candidate.sourceId);
          } else if (result.kind === "tool") {
            tools.push(result.definition);
            if (result.definition.hasExecute) {
              state.evaluation.requireRuntimeEntry(candidate.sourceId);
            }
          } else if (result.kind === "dynamic-tool") {
            dynamicTools.push(withExtensionNamespace(result.definition, candidate.owner));
            state.evaluation.requireRuntimeEntry(candidate.sourceId);
          } else {
            assertNonExtensionSpecialTool(candidate as AgentModuleCandidate, "Web search");
            tools.push(result.definition);
          }
          break;
        }
      }
    }

    if (sandbox === undefined) {
      throw new Error(`Agent node "${input.nodeId}" has no selected sandbox source.`);
    }
    assertUniqueBy(tools, (tool) => tool.name, "tool name");
    assertUniqueBy(dynamicTools, (tool) => tool.slug, "dynamic tool slug");
    assertUniqueBy(connections, (connection) => connection.connectionName, "connection name");
    assertUniqueBy(dynamicConnections, (connection) => connection.slug, "dynamic connection slug");
    assertUniqueBy(skills, (skill) => skill.name, "skill name");
    assertStaticConnectionOwnership({
      connectionNames: connections.map((connection) => connection.connectionName),
      subagentNames: state.projected.subagents
        .filter((subagent) => selectedSourceIds.has(subagent.candidate.sourceId))
        .map((subagent) => subagent.source.subagentId),
      toolNames: tools.map((tool) => tool.name),
    });

    const channelRoutes = compileChannelRoutes(state, channels, this.diagnostics, input.nodeId);
    const extensionMounts = compileExtensionMounts(input.manifest, state.composed, input.nodePath);
    for (const mount of extensionMounts) {
      state.evaluation.requireRuntimeEntry(mount.mountSourceId);
    }
    const bindings = state.evaluation.finalizeBindings();
    return createCompiledAgentResources({
      agentRoot: input.manifest.agentRoot,
      appRoot: input.manifest.appRoot,
      bindings,
      channelRoutes,
      connections,
      diagnosticsSummary: summarizeCompilerDiagnostics(this.diagnostics),
      dynamicConnections,
      dynamicInstructions,
      dynamicSkills,
      dynamicTools,
      extensionMounts,
      hooks,
      memories,
      instructions,
      sandbox,
      sandboxWorkspaces: input.manifest.sandboxWorkspaces.map((workspace) => ({
        logicalPath: workspace.logicalPath,
        rootEntries: [...workspace.rootEntries],
        sourceId: workspace.sourceId,
        sourcePath: workspace.sourcePath,
      })),
      schedules,
      scheduleCollections,
      skills,
      sourceComposition: state.composed.composition,
      tools,
    });
  }
}
