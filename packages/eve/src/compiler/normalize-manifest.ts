import { resolve } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { mountRefNamespace, packageStateNamespace } from "#discover/extensions.js";
import {
  type CompiledAgentManifest,
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledDynamicInstructionsDefinition,
  type CompiledExtensionMount,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledInstructionsDefinition,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  type CompiledWorkflowToolDefinition,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { WebSearchProvider } from "#shared/web-search.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import {
  loadModuleBackedDefinition,
  type ManifestCompileContext,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileSubagentGraph } from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import {
  createFilesystemModuleBindings,
  type CompiledModuleBinding,
} from "#compiler/module-binding.js";
import type { AgentSourceLayer } from "#compiler/agent-module-candidate.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import {
  composeAgentSources,
  createOriginModuleBacking,
  type AgentSourceOrigin,
  type ComposedAgentSources,
} from "#compiler/compose-agent-sources.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import { prepareKernelCapabilities } from "#compiler/prepare-kernel-capabilities.js";
import { prepareSourceComposition } from "#compiler/prepare-source-composition.js";
import {
  getKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtPath,
  type KernelCapabilityName,
} from "#kernel/capabilities.js";

/**
 * Compiles one discovery manifest into the normalized manifest loaded by the runtime.
 */
export interface CompileAgentManifestOptions {
  readonly applicationSourceOrigin?: AgentSourceOrigin;
  readonly modelCatalog?: ManifestCompileContext["modelCatalog"];
  readonly moduleRegistry?: AgentSourceRegistry;
}

export async function compileAgentManifest(
  manifest: AgentSourceManifest,
  options: CompileAgentManifestOptions = {},
): Promise<CompiledAgentManifest> {
  const context: ManifestCompileContext = {
    bindingsByNodeId: new Map(),
    compositionsByNodeId: new Map(),
    manifestsByNodeId: new Map(),
    modelCatalog: options.modelCatalog ?? createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
    moduleLoader: createAgentModuleNamespaceLoader({
      registry: options.moduleRegistry ?? frameworkAgentSourceRegistry,
    }),
  };
  const compiledNode = await compileAgentNodeManifest(manifest, context, {
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    sourceOrigin: options.applicationSourceOrigin,
  });
  const rootSources = context.manifestsByNodeId.get(ROOT_COMPILED_AGENT_NODE_ID) ?? manifest;
  const subagentGraph = await compileSubagentGraph({
    appRoot: manifest.appRoot,
    compileAgentNodeManifest,
    compileAgentResources,
    context,
    externalDependencies: compiledNode.config.build?.externalDependencies ?? [],
    parentAgentRoot: manifest.agentRoot,
    parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagents: rootSources.subagents,
  });

  const backgroundTool = [compiledNode, ...subagentGraph.nodes.map((node) => node.agent)]
    .flatMap((node) => node.tools)
    .find((tool) => tool.execution === "background");
  if (backgroundTool !== undefined && compiledNode.config.experimental?.tasks !== true) {
    throw new Error(
      `Background tool "${backgroundTool.name}" requires experimental.tasks: true in the root agent config.`,
    );
  }

  const compiledManifest = createCompiledAgentManifest({
    ...compiledNode,
    extensionMounts: compiledNode.extensionMounts,
    remoteAgents: subagentGraph.remoteAgents,
    subagentEdges: subagentGraph.edges,
    subagents: subagentGraph.nodes,
  });
  return {
    ...compiledManifest,
    bindings: createNodeBindings(
      compiledManifest,
      context,
      ROOT_COMPILED_AGENT_NODE_ID,
      compiledManifest.config.build?.externalDependencies,
    ),
  };
}

async function compileAgentNodeManifest(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: {
    readonly agentConfigDefinition?: unknown;
    readonly externalDependencies?: readonly string[];
    readonly allowRootOnlyConfig?: boolean;
    readonly nodeId?: string;
    readonly sourceOrigin?: AgentSourceOrigin;
    readonly sourcesComposed?: boolean;
  } = {},
): Promise<CompiledAgentNodeManifest> {
  const nodeId = options.nodeId ?? manifest.agentId;
  const configBinding =
    options.sourceOrigin === undefined || manifest.configModule === undefined
      ? undefined
      : {
          backing: createOriginModuleBacking({
            logicalPath: manifest.configModule.logicalPath,
            origin: options.sourceOrigin,
            sourcePath: resolve(manifest.agentRoot, manifest.configModule.logicalPath),
          }),
          logicalPath: manifest.configModule.logicalPath,
          owner: options.sourceOrigin.owner,
        };
  const rawConfig = Object.hasOwn(options, "agentConfigDefinition")
    ? await compileAgentConfig(manifest, context, {
        definition: options.agentConfigDefinition,
      })
    : await compileAgentConfig(manifest, context, { binding: configBinding });
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
  const externalDependencies = mergeExternalDependencies(
    options.externalDependencies,
    rawConfig.build?.externalDependencies,
    manifest.resolvedExtensions.flatMap((mount) => mount.externalDependencies),
  );
  const config =
    externalDependencies.length === 0
      ? rawConfig
      : {
          ...rawConfig,
          build: {
            ...rawConfig.build,
            externalDependencies,
          },
        };
  const sources = options.sourcesComposed
    ? getComposedSources(manifest, context, nodeId)
    : composeAgentSources({
        externalDependencies,
        isRoot: nodeId === ROOT_COMPILED_AGENT_NODE_ID,
        manifest,
        nodeId,
        origin: options.sourceOrigin,
        registry: frameworkAgentSourceRegistry,
      });
  manifest = sources.manifest;
  const bindings = bindOriginConfigModule(sources.bindings, manifest, options.sourceOrigin);
  context.bindingsByNodeId.set(nodeId, bindings);
  context.compositionsByNodeId.set(nodeId, sources.composition);
  context.manifestsByNodeId.set(nodeId, manifest);
  const resources = await compileAgentResources(manifest, context, {
    externalDependencies,
    nodeId,
    sourcesComposed: true,
    tasksEnabled: config.experimental?.tasks === true,
  });
  const compiledNode = createCompiledAgentNodeManifest({ ...resources, config });
  return {
    ...compiledNode,
    bindings: createNodeBindings(compiledNode, context, nodeId, config.build?.externalDependencies),
  };
}

async function compileAgentResources(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: {
    readonly externalDependencies?: readonly string[];
    readonly nodeId?: string;
    readonly sourceOrigin?: AgentSourceOrigin;
    readonly sourcesComposed?: boolean;
    readonly tasksEnabled?: boolean;
  } = {},
): Promise<CompiledAgentResources> {
  const nodeId = options.nodeId ?? manifest.agentId;
  const sources = options.sourcesComposed
    ? getComposedSources(manifest, context, nodeId)
    : composeAgentSources({
        externalDependencies: options.externalDependencies,
        isRoot: nodeId === ROOT_COMPILED_AGENT_NODE_ID,
        manifest,
        nodeId,
        origin: options.sourceOrigin,
        registry: frameworkAgentSourceRegistry,
      });
  manifest = sources.manifest;
  context.bindingsByNodeId.set(nodeId, sources.bindings);
  context.compositionsByNodeId.set(nodeId, sources.composition);
  context.manifestsByNodeId.set(nodeId, manifest);
  const externalDependencies = [...(options.externalDependencies ?? [])];
  const loadOptions = (sourceId: string): ModuleBackedDefinitionLoadOptions => ({
    binding: sources.bindings[sourceId],
    externalDependencies,
    moduleLoader: context.moduleLoader,
  });
  const compiledToolEntries = await Promise.all(
    manifest.tools.map(async (toolSource) => ({
      entry: await compileToolEntry(
        manifest.agentRoot,
        toolSource,
        loadOptions(toolSource.sourceId),
      ),
      source: toolSource,
    })),
  );
  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledKernelCapabilities = new Set<KernelCapabilityName>();
  const disabledWinnerSourceIds = new Set<string>();
  let frameworkLoadSkill = false;
  let workflowTool: CompiledWorkflowToolDefinition | undefined;
  let webSearchProvider: WebSearchProvider | undefined;

  for (const { entry, source } of compiledToolEntries) {
    const sourceComposition = findSourceComposition(sources, source.sourceId);
    assertExtensionToolPolicy(entry.kind, source.logicalPath, sourceComposition?.winner.layer);
    const kernelCapability = getKernelCapabilityAtPath(source.logicalPath);
    if (kernelCapability === "final_output") {
      throw new Error(
        `The source "${source.logicalPath}" occupies the reserved final_output kernel slot. Structured output owns this tool name when an agent requests an output schema.`,
      );
    }
    if (entry.kind === "tool") {
      tools.push(entry.definition);
      if (
        entry.definition.name === "load_skill" &&
        sourceComposition?.winner.owner.kind === "framework"
      ) {
        frameworkLoadSkill = true;
      }
    } else if (entry.kind === "dynamic-tool") {
      dynamicTools.push(withExtensionNamespace(entry.definition, sourceComposition));
    } else if (entry.kind === "workflow-tool") {
      workflowTool = { maxSubagents: entry.maxSubagents };
    } else if (entry.kind === "web-search-tool") {
      webSearchProvider = entry.provider;
    } else {
      const disabled = validateDisableTarget(source.logicalPath, sourceComposition);
      disabledWinnerSourceIds.add(source.sourceId);
      if (disabled.kind === "kernel") disabledKernelCapabilities.add(disabled.name);
    }
  }

  const compiledChannelResults = await Promise.all(
    manifest.channels.map(async (channelSource) => ({
      entries: await compileChannelDefinition(
        manifest.agentRoot,
        channelSource,
        loadOptions(channelSource.sourceId),
      ),
      source: channelSource,
    })),
  );

  // compileChannelDefinition returns one entry for a disabled-channel
  // sentinel or an array of entries (one per route) for an authored
  // CompiledChannel. Flatten so the manifest holds a single channel list.
  const compiledChannels = dedupeChannelRoutes(
    compiledChannelResults.flatMap(({ entries, source }) => {
      const flattened = Array.isArray(entries) ? entries : [entries];
      if (flattened[0]?.kind !== "disabled") return flattened;
      validateDisableTarget(source.logicalPath, findSourceComposition(sources, source.sourceId));
      disabledWinnerSourceIds.add(source.sourceId);
      return [];
    }),
  );

  const compiledSkillEntries = await Promise.all(
    manifest.skills.map(async (skillSource) => ({
      entry: await compileSkillSource(
        manifest.agentRoot,
        skillSource,
        loadOptions(skillSource.sourceId),
      ),
      source: skillSource,
    })),
  );
  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];

  for (const { entry, source } of compiledSkillEntries) {
    if (entry.kind === "skill") {
      skills.push(entry.definition);
    } else {
      dynamicSkills.push(
        withExtensionNamespace(entry.definition, findSourceComposition(sources, source.sourceId)),
      );
    }
  }

  const compiledInstructionsEntries = await Promise.all(
    manifest.instructions.map((source) =>
      compileInstructionsEntry(manifest.agentRoot, source, loadOptions(source.sourceId)),
    ),
  );
  const staticInstructions: CompiledInstructionsDefinition[] = [];
  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];

  for (const entry of compiledInstructionsEntries) {
    if (entry.kind === "instructions") {
      staticInstructions.push(entry.definition);
    } else {
      dynamicInstructions.push(entry.definition);
    }
  }

  const connections = await Promise.all(
    manifest.connections.map((connectionSource) =>
      compileConnectionDefinition(
        manifest.agentRoot,
        connectionSource,
        loadOptions(connectionSource.sourceId),
      ),
    ),
  );
  const hooks = await Promise.all(
    manifest.hooks.map(async (hookSource) =>
      compileHookEntry(
        hookSource,
        await loadModuleBackedDefinition({
          agentRoot: manifest.agentRoot,
          ...loadOptions(hookSource.sourceId),
          kind: "hook",
          source: hookSource,
        }),
      ),
    ),
  );
  const schedules = await Promise.all(
    manifest.schedules.map((scheduleSource) =>
      compileScheduleDefinition(
        manifest.agentRoot,
        scheduleSource,
        loadOptions(scheduleSource.sourceId),
      ),
    ),
  );

  const resources = createCompiledAgentResources({
    agentRoot: manifest.agentRoot,
    appRoot: manifest.appRoot,
    channels: compiledChannels,
    extensionMounts: compileExtensionMounts(manifest),
    connections,
    diagnosticsSummary: manifest.diagnosticsSummary,
    kernelCapabilities: prepareKernelCapabilities({
      disabled: disabledKernelCapabilities,
      frameworkLoadSkill,
      hasSkills: skills.length > 0 || dynamicSkills.length > 0,
      isRoot: nodeId === ROOT_COMPILED_AGENT_NODE_ID,
      tasksEnabled: options.tasksEnabled === true,
      toolNames: new Set(tools.map((tool) => tool.name)),
      webSearch: webSearchProvider !== undefined,
      workflow: workflowTool !== undefined,
    }),
    workflowTool,
    webSearchProvider,
    dynamicSkills,
    dynamicTools,
    hooks,
    sandbox:
      manifest.sandbox === null
        ? null
        : await compileSandboxDefinition(manifest.agentRoot, manifest.sandbox, {
            ...loadOptions(manifest.sandbox.sourceId),
          }),
    sandboxWorkspaces: manifest.sandboxWorkspaces.map((workspace) => ({
      logicalPath: workspace.logicalPath,
      rootEntries: [...workspace.rootEntries],
      sourceId: workspace.sourceId,
      sourcePath: workspace.sourcePath,
    })),
    schedules,
    sourceComposition: prepareSourceComposition({
      composition: sources.composition,
      disabledWinnerSourceIds,
    }),
    dynamicInstructions,
    skills,
    instructions: staticInstructions,
    tools,
  });
  return {
    ...resources,
    bindings: createNodeBindings(resources, context, nodeId, externalDependencies),
  };
}

function createNodeBindings(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  context: ManifestCompileContext,
  nodeId: string,
  externalDependencies?: readonly string[],
): CompiledAgentResources["bindings"] {
  const bindings = createFilesystemModuleBindings({
    agentRoot: manifest.agentRoot,
    externalDependencies,
    manifest,
  });
  const composedBindings = context.bindingsByNodeId.get(nodeId) ?? {};
  for (const sourceId of Object.keys(bindings)) {
    if (composedBindings[sourceId] !== undefined) {
      bindings[sourceId] = composedBindings[sourceId];
    }
  }
  return bindings;
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

function getComposedSources(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  nodeId: string,
): ComposedAgentSources {
  const composition = context.compositionsByNodeId.get(nodeId);
  if (composition === undefined) {
    throw new Error(`Agent node "${nodeId}" has no composed source graph.`);
  }
  return {
    bindings: context.bindingsByNodeId.get(nodeId) ?? {},
    composition,
    manifest,
  };
}

function findSourceComposition(sources: ComposedAgentSources, sourceId: string) {
  return sources.composition.entries.find((entry) => entry.winner.sourceId === sourceId);
}

function withExtensionNamespace<T extends { readonly extensionNamespace?: string }>(
  definition: T,
  composition: ReturnType<typeof findSourceComposition>,
): T {
  const extensionNamespace = composition?.winner.extensionNamespace;
  return extensionNamespace === undefined ? definition : { ...definition, extensionNamespace };
}

function dedupeChannelRoutes<T extends { readonly method: string; readonly urlPath: string }>(
  channels: readonly T[],
): T[] {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    const key = `${channel.method} ${channel.urlPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateDisableTarget(
  logicalPath: string,
  composition: ReturnType<typeof findSourceComposition>,
) {
  if (composition === undefined) {
    throw new Error(`Cannot validate the disable sentinel at "${logicalPath}".`);
  }
  const winner = composition.winner;
  if (winner.layer === "extension-package") {
    throw new Error(
      `The extension source "${logicalPath}" exports a disable sentinel, but extension packages cannot disable lower sources.`,
    );
  }
  const target = composition.candidates.at(-2);
  if (target === undefined) {
    const kernelCapability = getReplaceableKernelCapabilityAtPath(logicalPath);
    if (winner.layer === "application" && kernelCapability !== undefined) {
      return { kind: "kernel" as const, name: kernelCapability };
    }
    throw new Error(
      `The source "${logicalPath}" exports a disable sentinel, but no lower-precedence source occupies that slot.`,
    );
  }
  if (winner.layer === "extension-override" && target.layer !== "extension-package") {
    throw new Error(
      `The extension override "${logicalPath}" exports a disable sentinel, but its extension package contributes no source at that slot.`,
    );
  }
  return { kind: "source" as const, target };
}

function assertExtensionToolPolicy(
  kind: "disabled" | "dynamic-tool" | "tool" | "web-search-tool" | "workflow-tool",
  logicalPath: string,
  layer: AgentSourceLayer | undefined,
): void {
  if (layer !== "extension-package" && layer !== "extension-override") return;
  const role = layer === "extension-package" ? "extension package" : "extension override";
  if (kind === "workflow-tool") {
    throw new Error(
      `The ${role} source "${logicalPath}" enables Workflow, but Workflow is owned by the consuming agent.`,
    );
  }
  if (kind === "web-search-tool") {
    throw new Error(
      `The ${role} source "${logicalPath}" configures web search, but its provider is owned by the consuming agent.`,
    );
  }
}

function bindOriginConfigModule(
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
  manifest: AgentSourceManifest,
  origin: AgentSourceOrigin | undefined,
): Readonly<Record<string, CompiledModuleBinding>> {
  if (origin === undefined || manifest.configModule === undefined) return bindings;
  const source = manifest.configModule;
  return {
    ...bindings,
    [source.sourceId]: {
      backing: createOriginModuleBacking({
        logicalPath: source.logicalPath,
        origin,
        sourcePath: resolve(manifest.agentRoot, source.logicalPath),
      }),
      logicalPath: source.logicalPath,
      owner: origin.owner,
    },
  };
}
