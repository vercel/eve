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
  composeAgentSubagentSources,
  compileExtensionContributions,
} from "#compiler/normalize-extension.js";
import type {
  ManifestCompileContext,
  ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileSubagentGraph } from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import { createFilesystemModuleBindings } from "#compiler/module-binding.js";
import { composeFrameworkSources } from "#compiler/compose-framework-sources.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";

/**
 * Compiles one discovery manifest into the normalized manifest loaded by the runtime.
 */
export async function compileAgentManifest(
  manifest: AgentSourceManifest,
): Promise<CompiledAgentManifest> {
  const context: ManifestCompileContext = {
    bindingsByAgentRoot: new Map(),
    modelCatalog: createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
    moduleLoader: createAgentModuleNamespaceLoader({ registry: frameworkAgentSourceRegistry }),
  };
  const rootSources = composeFrameworkSources({
    isRoot: true,
    manifest,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    registry: frameworkAgentSourceRegistry,
  });
  context.bindingsByAgentRoot.set(manifest.agentRoot, rootSources.bindings);
  const compiledNode = await compileAgentNodeManifest(rootSources.manifest, context, {
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    sourcesComposed: true,
  });
  const subagentGraph = await compileSubagentGraph({
    appRoot: manifest.appRoot,
    compileAgentNodeManifest,
    compileAgentResources,
    context,
    externalDependencies: compiledNode.config.build?.externalDependencies ?? [],
    parentAgentRoot: manifest.agentRoot,
    parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagents: composeAgentSubagentSources(rootSources.manifest),
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
    readonly sourcesComposed?: boolean;
  } = {},
): Promise<CompiledAgentNodeManifest> {
  const sources = options.sourcesComposed
    ? { bindings: context.bindingsByAgentRoot.get(manifest.agentRoot) ?? {}, manifest }
    : composeFrameworkSources({
        isRoot: false,
        manifest,
        nodeId: options.nodeId ?? manifest.agentId,
        registry: frameworkAgentSourceRegistry,
      });
  manifest = sources.manifest;
  context.bindingsByAgentRoot.set(manifest.agentRoot, sources.bindings);
  const rawConfig = Object.hasOwn(options, "agentConfigDefinition")
    ? await compileAgentConfig(manifest, context, {
        definition: options.agentConfigDefinition,
      })
    : await compileAgentConfig(manifest, context);
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
  const resources = await compileAgentResources(manifest, context, {
    externalDependencies,
    nodeId: options.nodeId,
    sourcesComposed: true,
  });
  const compiledNode = createCompiledAgentNodeManifest({ ...resources, config });
  return {
    ...compiledNode,
    bindings: createNodeBindings(compiledNode, context, config.build?.externalDependencies),
  };
}

async function compileAgentResources(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: {
    readonly externalDependencies?: readonly string[];
    readonly nodeId?: string;
    readonly sourcesComposed?: boolean;
  } = {},
): Promise<CompiledAgentResources> {
  const sources = options.sourcesComposed
    ? { bindings: context.bindingsByAgentRoot.get(manifest.agentRoot) ?? {}, manifest }
    : composeFrameworkSources({
        isRoot: false,
        manifest,
        nodeId: options.nodeId ?? manifest.agentId,
        registry: frameworkAgentSourceRegistry,
      });
  manifest = sources.manifest;
  context.bindingsByAgentRoot.set(manifest.agentRoot, sources.bindings);
  const externalDependencies = [...(options.externalDependencies ?? [])];
  const loadOptions = (sourceId: string): ModuleBackedDefinitionLoadOptions => ({
    binding: sources.bindings[sourceId],
    externalDependencies,
    moduleLoader: context.moduleLoader,
  });
  const compiledToolEntries = await Promise.all(
    manifest.tools.map((toolSource) =>
      compileToolEntry(manifest.agentRoot, toolSource, loadOptions(toolSource.sourceId)),
    ),
  );
  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledFrameworkTools: string[] = [];
  let workflowTool: CompiledWorkflowToolDefinition | undefined;
  let webSearchProvider: WebSearchProvider | undefined;

  for (const entry of compiledToolEntries) {
    if (entry.kind === "tool") {
      tools.push(entry.definition);
    } else if (entry.kind === "dynamic-tool") {
      dynamicTools.push(entry.definition);
    } else if (entry.kind === "workflow-tool") {
      workflowTool = { maxSubagents: entry.maxSubagents };
    } else if (entry.kind === "web-search-tool") {
      webSearchProvider = entry.provider;
    } else {
      disabledFrameworkTools.push(entry.name);
    }
  }

  const compiledChannelResults = await Promise.all(
    manifest.channels.map((channelSource) =>
      compileChannelDefinition(
        manifest.agentRoot,
        channelSource,
        loadOptions(channelSource.sourceId),
      ),
    ),
  );

  // compileChannelDefinition returns one entry for a disabled-channel
  // sentinel or an array of entries (one per route) for an authored
  // CompiledChannel. Flatten so the manifest holds a single channel list.
  const compiledChannels = compiledChannelResults.flat();

  const compiledSkillEntries = await Promise.all(
    manifest.skills.map((skillSource) =>
      compileSkillSource(manifest.agentRoot, skillSource, loadOptions(skillSource.sourceId)),
    ),
  );
  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];

  for (const entry of compiledSkillEntries) {
    if (entry.kind === "skill") {
      skills.push(entry.definition);
    } else {
      dynamicSkills.push(entry.definition);
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
  const hooks = manifest.hooks.map((hookSource) => compileHookEntry(hookSource));
  const schedules = await Promise.all(
    manifest.schedules.map((scheduleSource) =>
      compileScheduleDefinition(
        manifest.agentRoot,
        scheduleSource,
        loadOptions(scheduleSource.sourceId),
      ),
    ),
  );

  // Sorted by namespace so first-registration-wins dedup is deterministic when
  // two extensions contribute the same composed name.
  const toolNames = new Set(tools.map((tool) => tool.name));
  const dynamicToolSlugs = new Set(dynamicTools.map((tool) => tool.slug));
  const connectionNames = new Set(connections.map((connection) => connection.connectionName));
  const skillNames = new Set(skills.map((skill) => skill.name));
  const extensionInstructions: CompiledInstructionsDefinition[] = [];
  for (const mount of [...manifest.resolvedExtensions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    const contributions = await compileExtensionContributions({
      mount,
      context,
      consumerAgentRoot: manifest.agentRoot,
      externalDependencies,
    });
    compiledChannels.push(...contributions.channels);
    for (const tool of contributions.tools) {
      if (!toolNames.has(tool.name)) {
        toolNames.add(tool.name);
        tools.push(tool);
      }
    }
    for (const tool of contributions.dynamicTools) {
      if (!dynamicToolSlugs.has(tool.slug)) {
        dynamicToolSlugs.add(tool.slug);
        dynamicTools.push(tool);
      }
    }
    for (const connection of contributions.connections) {
      if (!connectionNames.has(connection.connectionName)) {
        connectionNames.add(connection.connectionName);
        connections.push(connection);
      }
    }
    for (const skill of contributions.skills) {
      if (!skillNames.has(skill.name)) {
        skillNames.add(skill.name);
        skills.push(skill);
      }
    }
    schedules.push(...contributions.schedules);
    hooks.push(...contributions.hooks);
    dynamicSkills.push(...contributions.dynamicSkills);
    dynamicInstructions.push(...contributions.dynamicInstructions);
    extensionInstructions.push(...contributions.instructions);
  }

  const instructions = [...staticInstructions, ...extensionInstructions];

  const resources = createCompiledAgentResources({
    agentRoot: manifest.agentRoot,
    appRoot: manifest.appRoot,
    channels: compiledChannels,
    extensionMounts: compileExtensionMounts(manifest),
    connections,
    diagnosticsSummary: manifest.diagnosticsSummary,
    disabledFrameworkTools,
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
    dynamicInstructions,
    skills,
    instructions,
    tools,
  });
  return {
    ...resources,
    bindings: createNodeBindings(resources, context, externalDependencies),
  };
}

function createNodeBindings(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  context: ManifestCompileContext,
  externalDependencies?: readonly string[],
): CompiledAgentResources["bindings"] {
  return {
    ...createFilesystemModuleBindings({
      agentRoot: manifest.agentRoot,
      externalDependencies,
      manifest,
    }),
    ...context.bindingsByAgentRoot.get(manifest.agentRoot),
  };
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
