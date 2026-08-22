import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type {
  AgentInfoDynamicResolverEntry,
  AgentInfoKernelCapabilityEntry,
  AgentInfoResult,
  AgentInfoSource,
  AgentInfoSubagentEntry,
} from "#client/agent-info-schema.js";
import type {
  CompiledAgentManifest,
  CompiledSourceReference,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  KERNEL_CAPABILITIES,
  RESERVED_KERNEL_CAPABILITY_NAMES,
  type KernelCapabilityName,
} from "#kernel/capabilities.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";

export type AgentInfoResponse = AgentInfoResult;

function toChatGptEndpoint(state: ChatGptAuthState | undefined) {
  if (state === undefined) return undefined;
  return {
    state: state.kind,
    ...(state.kind === "ready" &&
      state.accountLabel !== undefined && { accountLabel: state.accountLabel }),
  };
}

/**
 * Projects the complete inspection response from the effective compiled graph.
 * It never imports authored modules or reconstructs framework catalogs.
 */
export function buildAgentInfoResponse(
  data: AgentInfoManifestData,
  input: {
    readonly mode: AgentInfoResult["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
  },
): AgentInfoResult {
  const manifest = data.manifest;

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      configSource:
        manifest.config.source === undefined
          ? undefined
          : toSource(manifest, manifest.config.source),
      description: manifest.config.description,
      model:
        manifest.config.dynamicModel === undefined
          ? {
              contextWindowTokens: manifest.config.model.contextWindowTokens,
              id: manifest.config.model.id,
              providerOptions: manifest.config.model.providerOptions,
              reasoning: manifest.config.reasoning,
              source:
                manifest.config.model.source === undefined
                  ? undefined
                  : toSource(manifest, manifest.config.model.source),
              routing: manifest.config.model.routing,
              endpoint: resolveModelEndpointStatus(
                manifest.config.model.routing,
                input.gatewayCredentials,
                toChatGptEndpoint(input.chatgptAuth),
              ),
            }
          : {
              reasoning: manifest.config.reasoning,
              routing: { kind: "dynamic" },
            },
      name: manifest.config.name,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: {
      devRoutes: input.mode === "development",
    },
    channels: manifest.channels.map((channel) => ({
      ...toSource(manifest, channel),
      adapterKind: channel.adapterKind,
      method: channel.method,
      name: channel.name,
      urlPath: channel.urlPath,
    })),
    composition: {
      disabled: manifest.sourceComposition.disabled.map((entry) => ({
        slot: entry.slot,
        source: toCompositionSource(entry.source),
        target: entry.target === undefined ? undefined : toCompositionSource(entry.target),
      })),
      shadowed: manifest.sourceComposition.shadowed.map((entry) => ({
        by: toCompositionSource(entry.by),
        slot: entry.slot,
        source: toCompositionSource(entry.source),
      })),
    },
    connections: manifest.connections.map((connection) => ({
      ...toSource(manifest, connection),
      connectionName: connection.connectionName,
      description: connection.description,
      hasApproval: connection.hasApproval,
      hasAuthorization: connection.hasAuthorization,
      hasHeaders: connection.hasHeaders,
      protocol: connection.protocol,
      url: connection.url,
    })),
    diagnostics: {
      discoveryErrors: manifest.diagnosticsSummary.errors,
      discoveryWarnings: manifest.diagnosticsSummary.warnings,
    },
    hooks: manifest.hooks.map((hook) => ({
      ...toSource(manifest, hook),
      eventNames: [...hook.eventNames],
      slug: hook.slug,
    })),
    instructions: {
      dynamic: manifest.dynamicInstructions.map((resolver) =>
        renderDynamicResolver(manifest, resolver),
      ),
      static: manifest.instructions.map((instructions) => ({
        ...toSource(manifest, instructions),
        content: instructions.content,
        name: instructions.name,
        role: instructions.role,
      })),
    },
    kernel: {
      prepared: manifest.kernelCapabilities.map(renderKernelCapability),
      reserved: RESERVED_KERNEL_CAPABILITY_NAMES.map(renderKernelCapability),
    },
    kind: "eve-agent-info",
    mode: input.mode,
    sandbox:
      manifest.sandbox === null
        ? null
        : {
            ...toSource(manifest, manifest.sandbox),
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
      dynamic: manifest.dynamicSkills.map((resolver) => renderDynamicResolver(manifest, resolver)),
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
      local: manifest.subagents.map((subagent) => renderSubagent(manifest, subagent)),
      total: manifest.subagents.length,
    },
    tools: {
      dynamic: manifest.dynamicTools.map((resolver) => renderDynamicResolver(manifest, resolver)),
      static: manifest.tools.map((tool) => ({
        ...toSource(manifest, tool),
        description: tool.description,
        hasAuth: false,
        hasExecute: tool.hasExecute ?? true,
        hasModelOutputProjection: tool.hasModelOutputProjection ?? false,
        hasOutputSchema: tool.outputSchema !== undefined && tool.outputSchema !== null,
        inputSchema: tool.inputSchema,
        name: tool.name,
        outputSchema: tool.outputSchema,
        requiresApproval: tool.requiresApproval ?? false,
      })),
    },
    version: 3,
    workspace: {
      resourceRoot: manifest.workspaceResourceRoot,
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}

function renderKernelCapability(name: KernelCapabilityName): AgentInfoKernelCapabilityEntry {
  const definition = KERNEL_CAPABILITIES[name];
  return {
    audience: definition.audience,
    canonicalPath: definition.canonicalPath,
    conditions: [...definition.conditions],
    materialization: definition.materialization,
    name,
  };
}

function renderDynamicResolver(
  manifest: CompiledAgentManifest,
  resolver: {
    readonly eventNames: readonly string[];
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly slug: string;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
): AgentInfoDynamicResolverEntry {
  return {
    ...toSource(manifest, resolver),
    eventNames: [...resolver.eventNames],
    slug: resolver.slug,
  };
}

function renderSubagent(
  manifest: CompiledAgentManifest,
  subagent: CompiledSubagentNode,
): AgentInfoSubagentEntry {
  return {
    ...toSource(manifest, subagent),
    description: subagent.description,
    entryPath: subagent.entryPath,
    name: subagent.name,
    nodeId: subagent.nodeId,
    rootPath: subagent.rootPath,
    summary: {
      channels: subagent.agent.channels.length,
      connections: subagent.agent.connections.length,
      hooks: subagent.agent.hooks.length,
      instructions: subagent.agent.instructions.length > 0,
      schedules: subagent.agent.schedules.length,
      skills: subagent.agent.skills.length,
      tools: subagent.agent.tools.length,
    },
  };
}

function toSource(
  manifest: CompiledAgentManifest,
  source: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId?: string;
    readonly sourceKind: string;
  },
): AgentInfoSource {
  const sourceId = source.sourceId;
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    owner: (sourceId === undefined ? undefined : manifest.bindings[sourceId]?.owner) ??
      (sourceId === undefined ? undefined : manifest.sourceComposition.sourceOwners[sourceId]) ?? {
        kind: "application",
      },
    sourceId,
    sourceKind: source.sourceKind,
  };
}

function toCompositionSource(source: CompiledSourceReference): CompiledSourceReference {
  return {
    logicalPath: source.logicalPath,
    owner: source.owner,
    sourceId: source.sourceId,
  };
}
