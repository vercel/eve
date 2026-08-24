import type {
  AgentInfoChannelEntry,
  AgentInfoDynamicResolverEntry,
  AgentInfoNamedDynamicResolverEntry,
  AgentInfoOwner,
  AgentInfoRemoteAgentEntry,
  AgentInfoResult,
  AgentInfoSource,
  AgentInfoSubagentEntry,
  AgentInfoToolEntry,
} from "#client/agent-info-schema.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledChannelDefinition,
  type CompiledRemoteAgentNode,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import type { AgentSourceDescriptor } from "#compiler/source-composition.js";
import { requireAgreedCompiledModuleRef } from "#compiler/module-binding.js";
import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";
import { projectPreparedKernelCapabilitiesForInspection } from "#kernel/capabilities.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";

export type AgentInfoResponse = AgentInfoResult;

type ManifestResources = CompiledAgentManifest | CompiledAgentNodeManifest | CompiledAgentResources;
type BindingResources = Pick<ManifestResources, "bindings">;

interface SourceReference {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
  readonly sourceKind: AgentInfoSource["sourceKind"];
}

function toChatGptEndpoint(state: ChatGptAuthState | undefined) {
  if (state === undefined) return undefined;
  return {
    state: state.kind,
    ...(state.kind === "ready" &&
      state.accountLabel !== undefined && { accountLabel: state.accountLabel }),
  };
}

/** Projects `/eve/v1/info` solely from serialized compiler and kernel authority. */
export function buildAgentInfoResponse(
  data: AgentInfoManifestData,
  input: {
    readonly mode: AgentInfoResult["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
  },
): AgentInfoResult {
  const manifest = data.manifest;
  const kernelProjection = projectPreparedKernelCapabilitiesForInspection(manifest.kernelPlan);
  const frameworkSources = [...kernelProjection.frameworkSourcePaths].map((logicalPath) => {
    const matches = manifest.tools.filter((tool) => tool.logicalPath === logicalPath);
    if (matches.length !== 1) {
      throw new Error(
        `Compiled kernel source "${logicalPath}" must resolve to exactly one compiled tool.`,
      );
    }
    const tool = matches[0]!;
    const binding = requireModuleBinding(manifest, tool);
    if (binding.owner.kind !== "framework") {
      throw new Error(`Compiled kernel source "${logicalPath}" is not framework-owned.`);
    }
    return renderTool(manifest, tool);
  });
  const kernelSourceIds = new Set(frameworkSources.map((source) => source.sourceId));
  const localParentNodeIds = new Map(
    manifest.subagentEdges.map((edge) => [edge.childNodeId, edge.parentNodeId] as const),
  );
  const localSubagents = manifest.subagents.map((subagent) =>
    renderSubagent(subagent, requireLocalParentNodeId(localParentNodeIds, subagent.nodeId)),
  );
  const remoteAgents = [
    ...manifest.remoteAgents.map((remoteAgent) =>
      renderRemoteAgent(remoteAgent, ROOT_COMPILED_AGENT_NODE_ID),
    ),
    ...manifest.subagents.flatMap((parent) =>
      parent.agent.remoteAgents.map((remoteAgent) => renderRemoteAgent(remoteAgent, parent.nodeId)),
    ),
  ];

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      configSource: toModuleSource(manifest, manifest.config.source),
      description: manifest.config.description,
      model:
        manifest.config.dynamicModel === undefined
          ? {
              contextWindowTokens: manifest.config.model.contextWindowTokens,
              endpoint: resolveModelEndpointStatus(
                manifest.config.model.routing,
                input.gatewayCredentials,
                toChatGptEndpoint(input.chatgptAuth),
              ),
              id: manifest.config.model.id,
              maxOutputTokens: manifest.config.model.maxOutputTokens,
              providerOptions: manifest.config.model.providerOptions,
              reasoning: manifest.config.reasoning,
              routing: manifest.config.model.routing,
              source:
                manifest.config.model.source === undefined
                  ? undefined
                  : toModuleSource(manifest, manifest.config.model.source),
            }
          : {
              reasoning: manifest.config.reasoning,
              routing: {
                kind: "dynamic",
                resolver: renderDynamicResolver(manifest, manifest.config.dynamicModel),
              },
            },
      name: manifest.config.name,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: { devRoutes: input.mode === "development" },
    channels: manifest.channelRoutes.effective.map((channel) => renderChannel(manifest, channel)),
    composition: {
      disabled: manifest.sourceComposition.disabled.map((entry) => ({
        slot: entry.slot,
        source: renderCompositionSource(entry.source),
      })),
      routes: {
        shadowed: manifest.channelRoutes.shadowed.map((entry) => ({
          loser: renderChannelWithOwner(entry.loser.route, entry.loser.binding.owner),
          method: entry.method,
          pathPattern: entry.pathPattern,
          winningSourceId: entry.winningSourceId,
        })),
      },
      selected: manifest.sourceComposition.selected.map((entry) =>
        entry.sourceKind === "module"
          ? {
              slot: entry.slot,
              source: toModuleSource(
                manifest,
                requireAgreedCompiledModuleRef(manifest, entry.sourceId),
              ),
              sourceKind: "module" as const,
            }
          : {
              slot: entry.slot,
              source: renderCompositionSource(entry.source),
              sourceKind: "non-module" as const,
            },
      ),
      shadowed: manifest.sourceComposition.shadowed.map((entry) => ({
        slot: entry.slot,
        source: renderCompositionSource(entry.source),
        winningSourceId: entry.winningSourceId,
      })),
    },
    connections: manifest.connections.map((connection) => ({
      ...toModuleSource(manifest, connection),
      connectionName: connection.connectionName,
      description: connection.description,
      hasApproval: connection.hasApproval,
      hasAuthorization: connection.hasAuthorization,
      hasHeaders: connection.hasHeaders,
      protocol: connection.protocol,
      url: connection.url,
    })),
    diagnostics: {
      errors: manifest.diagnosticsSummary.errors,
      warnings: manifest.diagnosticsSummary.warnings,
    },
    hooks: manifest.hooks.map((hook) => ({
      ...toModuleSource(manifest, hook),
      eventNames: [...hook.eventNames],
      slug: hook.slug,
    })),
    instructions: {
      dynamic: manifest.dynamicInstructions.map((resolver) =>
        renderNamedDynamicResolver(manifest, resolver),
      ),
      static: manifest.instructions.map((instructions) => ({
        ...toSource(manifest, instructions),
        content: instructions.content,
        name: instructions.name,
        role: instructions.role,
      })),
    },
    kernel: {
      availability: "prepared-potential",
      frameworkSources,
      native: kernelProjection.native.map((capability) => ({ ...capability })),
    },
    kind: "eve-agent-info",
    mode: input.mode,
    remoteAgents: {
      entries: remoteAgents,
      total: remoteAgents.length,
    },
    sandbox: {
      ...toModuleSource(manifest, manifest.sandbox),
      backendKind: manifest.sandbox.backendName,
      description: manifest.sandbox.description,
      hasBootstrap: manifest.sandbox.hasBootstrap,
      hasOnSession: manifest.sandbox.hasOnSession,
      revalidationKey: manifest.sandbox.revalidationKey,
      sourceHash: manifest.sandbox.sourceHash,
    },
    schedules: manifest.schedules.map((schedule) => ({
      ...toSource(manifest, schedule),
      cron: schedule.cron,
      hasRun: schedule.hasRun,
      markdown: schedule.markdown,
      name: schedule.name,
    })),
    skills: {
      dynamic: manifest.dynamicSkills.map((resolver) =>
        renderNamedDynamicResolver(manifest, resolver),
      ),
      static: manifest.skills.map((skill) => ({
        ...toSource(manifest, skill),
        description: skill.description,
        license: skill.license,
        markdown: skill.markdown,
        metadata: skill.metadata,
        name: skill.name,
      })),
    },
    subagents: {
      local: localSubagents,
      total: localSubagents.length,
    },
    tools: {
      dynamic: manifest.dynamicTools.map((resolver) =>
        renderNamedDynamicResolver(manifest, resolver),
      ),
      static: manifest.tools
        .filter((tool) => !kernelSourceIds.has(tool.sourceId))
        .map((tool) => renderTool(manifest, tool)),
    },
    version: 3,
    workspace: {
      resourceRoot: manifest.workspaceResourceRoot,
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}

function requireLocalParentNodeId(
  parentNodeIds: ReadonlyMap<string, string>,
  nodeId: string,
): string {
  const parentNodeId = parentNodeIds.get(nodeId);
  if (parentNodeId === undefined) {
    throw new Error(`Compiled local agent "${nodeId}" is missing its parent edge.`);
  }
  return parentNodeId;
}

function renderTool(
  resources: ManifestResources,
  tool: ManifestResources["tools"][number],
): AgentInfoToolEntry {
  return {
    ...toModuleSource(resources, tool),
    description: tool.description,
    hasAuth: tool.hasAuth,
    hasExecute: tool.hasExecute,
    hasModelOutputProjection: tool.hasModelOutputProjection,
    hasOutputSchema: tool.outputSchema !== undefined,
    inputSchema: tool.inputSchema,
    name: tool.name,
    outputSchema: tool.outputSchema,
    requiresApproval: tool.requiresApproval,
  };
}

function renderDynamicResolver(
  resources: ManifestResources,
  resolver: {
    readonly eventNames: readonly string[];
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly sourceKind: "module";
  },
): AgentInfoDynamicResolverEntry {
  return {
    ...toModuleSource(resources, resolver),
    eventNames: [...resolver.eventNames],
  };
}

function renderNamedDynamicResolver(
  resources: ManifestResources,
  resolver: {
    readonly eventNames: readonly string[];
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly slug: string;
    readonly sourceId: string;
    readonly sourceKind: "module";
  },
): AgentInfoNamedDynamicResolverEntry {
  return { ...renderDynamicResolver(resources, resolver), slug: resolver.slug };
}

function renderSubagent(
  subagent: CompiledSubagentNode,
  parentNodeId: string,
): AgentInfoSubagentEntry {
  const common = {
    ...toSubagentSource(subagent),
    entryPath: subagent.entryPath,
    name: subagent.name,
    nodeId: subagent.nodeId,
    parentNodeId,
    rootPath: subagent.rootPath,
    summary: {
      channels: subagent.agent.channelRoutes.effective.length,
      connections: subagent.agent.connections.length,
      hooks: subagent.agent.hooks.length,
      instructions:
        subagent.agent.instructions.length + subagent.agent.dynamicInstructions.length > 0,
      schedules: subagent.agent.schedules.length,
      skills: subagent.agent.skills.length + subagent.agent.dynamicSkills.length,
      tools: subagent.agent.tools.length + subagent.agent.dynamicTools.length,
    },
  };
  return subagent.configResolver === undefined
    ? { ...common, description: subagent.description }
    : {
        ...common,
        configResolver: renderDynamicResolver(subagent.agent, subagent.configResolver),
      };
}

function renderRemoteAgent(
  remoteAgent: CompiledRemoteAgentNode,
  parentNodeId: string,
): AgentInfoRemoteAgentEntry {
  return {
    ...toSubagentSource(remoteAgent),
    configResolver: toModuleSource(remoteAgent, remoteAgent.configResolver),
    description: remoteAgent.description,
    entryPath: remoteAgent.entryPath,
    name: remoteAgent.name,
    nodeId: remoteAgent.nodeId,
    outputSchema: remoteAgent.outputSchema,
    parentNodeId,
    path: remoteAgent.path,
    rootPath: remoteAgent.rootPath,
    url: remoteAgent.url,
  };
}

function renderChannel(
  resources: ManifestResources,
  channel: CompiledChannelDefinition,
): AgentInfoChannelEntry {
  return renderChannelWithOwner(channel, requireModuleBinding(resources, channel).owner);
}

function renderChannelWithOwner(
  channel: CompiledChannelDefinition,
  owner: AgentInfoOwner,
): AgentInfoChannelEntry {
  return {
    ...toSourceWithOwner(channel, owner),
    adapterKind: channel.adapterKind,
    method: channel.method,
    name: channel.name,
    urlPath: channel.urlPath,
  };
}

function renderCompositionSource(source: AgentSourceDescriptor) {
  return {
    ...toSourceWithOwner(source, source.owner),
    layer: source.layer,
  };
}

function toSubagentSource(source: {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly owner: AgentInfoOwner;
  readonly sourceId: string;
}): AgentInfoSource & { readonly sourceKind: "subagent" } {
  return toSourceWithOwner({ ...source, sourceKind: "subagent" }, source.owner);
}

function toModuleSource(
  resources: BindingResources,
  source: Omit<SourceReference, "sourceKind"> & { readonly sourceKind: "module" },
): AgentInfoSource & { readonly sourceKind: "module" } {
  return toSourceWithOwner(source, requireModuleBinding(resources, source).owner);
}

function toSource<Kind extends AgentInfoSource["sourceKind"]>(
  resources: ManifestResources,
  source: Omit<SourceReference, "sourceKind"> & { readonly sourceKind: Kind },
): AgentInfoSource & { readonly sourceKind: Kind } {
  if (source.sourceKind === "module") {
    return toModuleSource(
      resources,
      source as Omit<SourceReference, "sourceKind"> & { readonly sourceKind: "module" },
    ) as AgentInfoSource & { readonly sourceKind: Kind };
  }
  const selected = resources.sourceComposition.selected.find(
    (entry) => entry.sourceKind === "non-module" && entry.source.sourceId === source.sourceId,
  );
  if (selected === undefined || selected.sourceKind !== "non-module") {
    throw new Error(`Compiled source "${source.sourceId}" is missing selected ownership.`);
  }
  if (
    selected.source.logicalPath !== source.logicalPath ||
    selected.source.sourceKind !== source.sourceKind
  ) {
    throw new Error(`Compiled source "${source.sourceId}" does not match its selected descriptor.`);
  }
  return toSourceWithOwner(source, selected.source.owner);
}

function toSourceWithOwner<Kind extends AgentInfoSource["sourceKind"]>(
  source: Omit<SourceReference, "sourceKind"> & { readonly sourceKind: Kind },
  owner: AgentInfoOwner,
): AgentInfoSource & { readonly sourceKind: Kind } {
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    owner,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };
}

function requireModuleBinding(
  resources: BindingResources,
  source: { readonly logicalPath: string; readonly sourceId: string },
) {
  const binding = requireModuleBindingById(resources, source.sourceId);
  if (binding.logicalPath !== source.logicalPath) {
    throw new Error(
      `Compiled source "${source.sourceId}" has logical path "${source.logicalPath}", but its binding owns "${binding.logicalPath}".`,
    );
  }
  return binding;
}

function requireModuleBindingById(resources: BindingResources, sourceId: string) {
  const binding = resources.bindings[sourceId];
  if (binding === undefined) {
    throw new Error(`Compiled module source "${sourceId}" is missing its binding.`);
  }
  return binding;
}
