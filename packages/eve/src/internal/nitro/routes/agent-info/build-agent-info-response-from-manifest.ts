import type {
  AgentInfoDynamicResolverEntry,
  AgentInfoKernelPreparedEntry,
  AgentInfoOwner,
  AgentInfoRemoteAgentEntry,
  AgentInfoResult,
  AgentInfoSource,
  AgentInfoSubagentEntry,
} from "#client/agent-info-schema.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledAgentResources,
} from "#compiler/manifest.js";
import type { AgentSourceOwner, CompiledModuleBinding } from "#compiler/source-graph.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";

type NodeBindings = Readonly<Record<string, CompiledModuleBinding>>;

/**
 * Static mapping from surviving framework tool slots to the kernel effects
 * the runtime prepares for them. Application- or extension-owned tools with
 * the same names are ordinary tools, never kernel effects.
 */
const KERNEL_TOOL_EFFECTS: Readonly<
  Record<string, Pick<AgentInfoKernelPreparedEntry, "action" | "kind">>
> = {
  agent: { action: "subagent-call", kind: "dispatch" },
  ask_question: { kind: "request-input" },
  task_cancel: { action: "task-cancel", kind: "dispatch" },
  task_update: { action: "task-update", kind: "dispatch" },
  web_search: { kind: "provider-tool" },
};

function toChatGptEndpoint(state: ChatGptAuthState | undefined) {
  if (state === undefined) return undefined;
  return {
    state: state.kind,
    ...(state.kind === "ready" &&
      state.accountLabel !== undefined && { accountLabel: state.accountLabel }),
  };
}

/**
 * Projects the compiled agent manifest into the versioned `/eve/v1/info`
 * payload. The manifest is the single source of truth: every entry's owner
 * comes from the node's binding table (module-backed sources) or from the
 * compiled record itself (markdown and skill-package sources) — a source
 * with neither is a compiler bug and fails the projection.
 */
export function buildAgentInfoResponse(
  manifest: CompiledAgentManifest,
  extra: {
    readonly mode: AgentInfoResult["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
  },
): AgentInfoResult {
  const bindings = manifest.bindings;
  const kernelPrepared: AgentInfoKernelPreparedEntry[] = [];
  const toolEntries: AgentInfoResult["tools"]["entries"][number][] = [];

  for (const tool of manifest.tools) {
    const owner = requireBindingOwner(bindings, tool.sourceId, `tool "${tool.name}"`);
    const effect = KERNEL_TOOL_EFFECTS[tool.name];
    if (owner.kind === "framework" && effect !== undefined) {
      kernelPrepared.push({
        ...effect,
        source: toSource(tool.logicalPath, tool.sourceId, owner),
        toolName: tool.name,
      });
      continue;
    }
    toolEntries.push({
      description: tool.description,
      execution: tool.execution,
      hasAuth: false,
      inputSchema: tool.inputSchema,
      name: tool.name,
      outputSchema: tool.outputSchema,
      source: toSource(tool.logicalPath, tool.sourceId, owner),
    });
  }

  const nodes: readonly { nodeId: string; resources: CompiledAgentResources }[] = [
    { nodeId: ROOT_COMPILED_AGENT_NODE_ID, resources: manifest },
    ...manifest.subagents.map((subagent) => ({
      nodeId: subagent.nodeId,
      resources: subagent.agent,
    })),
  ];

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      config: { source: projectConfigSource(manifest) },
      description: manifest.config.description,
      model: projectModel(manifest, extra),
      name: manifest.config.name,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: {
      devRoutes: extra.mode === "development",
    },
    channels: {
      routes: manifest.channelRoutes.effective.map((route) => ({
        adapterKind: route.adapterKind,
        channelName: route.name,
        method: route.method,
        path: route.urlPath,
        source: toSource(
          route.logicalPath,
          route.sourceId,
          requireBindingOwner(bindings, route.sourceId, `channel "${route.name}"`),
        ),
      })),
      shadowed: manifest.channelRoutes.shadowed.map((shadowed) => ({
        adapterKind: undefined,
        channelName: shadowed.loser.name,
        method: shadowed.method,
        path: shadowed.urlPath,
        source: toSource(shadowed.loser.logicalPath, shadowed.loser.sourceId, shadowed.loser.owner),
        winningSourceId: shadowed.winningSourceId,
      })),
      total: manifest.channelRoutes.effective.length,
    },
    composition: {
      disabled: nodes.flatMap((node) =>
        node.resources.sourceComposition.disabled.map((entry) => ({
          logicalPath: entry.disabledBy.logicalPath,
          nodeId: node.nodeId,
          owner: projectOwner(entry.disabledBy.owner),
          slot: entry.slot,
        })),
      ),
      shadowed: nodes.flatMap((node) =>
        node.resources.sourceComposition.shadowed.map((entry) => ({
          logicalPath: entry.loser.logicalPath,
          nodeId: node.nodeId,
          owner: projectOwner(entry.loser.owner),
          slot: entry.slot,
          winningSourceId: entry.winningSourceId,
        })),
      ),
    },
    connections: manifest.connections.map((connection) => ({
      description: connection.description,
      name: connection.connectionName,
      protocol: connection.protocol,
      source: toSource(
        connection.logicalPath,
        connection.sourceId,
        requireBindingOwner(
          bindings,
          connection.sourceId,
          `connection "${connection.connectionName}"`,
        ),
      ),
      url: connection.url,
    })),
    diagnostics: {
      discoveryErrors: manifest.diagnosticsSummary.errors,
      discoveryWarnings: manifest.diagnosticsSummary.warnings,
    },
    hooks: manifest.hooks.map((hook) => ({
      slug: hook.slug,
      source: toSource(
        hook.logicalPath,
        hook.sourceId,
        requireBindingOwner(bindings, hook.sourceId, `hook "${hook.slug}"`),
      ),
    })),
    instructions: {
      dynamicResolvers: manifest.dynamicInstructions.map((resolver) =>
        projectDynamicResolver(bindings, resolver),
      ),
      entries: manifest.instructions.map((instructions) => ({
        content: instructions.content,
        name: instructions.name,
        role: instructions.role,
        source: projectRecordSource(bindings, instructions, `instructions "${instructions.name}"`),
      })),
    },
    kernel: {
      prepared: kernelPrepared,
    },
    kind: "eve-agent-info",
    mode: extra.mode,
    remoteAgents: projectRemoteAgents(nodes),
    sandbox: {
      backendName: manifest.sandbox.backendName,
      description: manifest.sandbox.description,
      source: toSource(
        manifest.sandbox.logicalPath,
        manifest.sandbox.sourceId,
        requireBindingOwner(bindings, manifest.sandbox.sourceId, "sandbox"),
      ),
    },
    schedules: manifest.schedules.map((schedule) => ({
      cron: schedule.cron,
      hasRun: schedule.hasRun,
      name: schedule.name,
      source: projectRecordSource(bindings, schedule, `schedule "${schedule.name}"`),
    })),
    skills: {
      dynamicResolvers: manifest.dynamicSkills.map((resolver) =>
        projectDynamicResolver(bindings, resolver),
      ),
      entries: manifest.skills.map((skill) => ({
        description: skill.description,
        name: skill.name,
        source: projectRecordSource(bindings, skill, `skill "${skill.name}"`),
      })),
    },
    subagents: {
      local: projectSubagents(manifest),
      total: manifest.subagents.length,
    },
    tools: {
      dynamicResolvers: manifest.dynamicTools.map((resolver) =>
        projectDynamicResolver(bindings, resolver),
      ),
      entries: toolEntries,
    },
    version: 3,
    workspace: {
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}

function projectConfigSource(manifest: CompiledAgentManifest): AgentInfoSource {
  const source = manifest.config.source;
  if (source === undefined) {
    throw new Error(
      `Compiled agent config for "${manifest.config.name}" carries no source reference.`,
    );
  }
  return toSource(
    source.logicalPath,
    source.sourceId,
    requireBindingOwner(manifest.bindings, source.sourceId, "agent config"),
  );
}

function projectModel(
  manifest: CompiledAgentManifest,
  extra: {
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
  },
): AgentInfoResult["agent"]["model"] {
  const config = manifest.config;
  if (config.dynamicModel !== undefined) {
    return {
      reasoning: config.reasoning,
      routing: {
        kind: "dynamic",
        resolver: projectDynamicResolver(manifest.bindings, {
          eventNames: config.dynamicModel.eventNames,
          logicalPath: config.dynamicModel.logicalPath,
          sourceId: config.dynamicModel.sourceId,
        }),
      },
    };
  }
  return {
    contextWindowTokens: config.model.contextWindowTokens,
    endpoint: resolveModelEndpointStatus(
      config.model.routing,
      extra.gatewayCredentials,
      toChatGptEndpoint(extra.chatgptAuth),
    ),
    id: config.model.id,
    providerOptions: config.model.providerOptions,
    reasoning: config.reasoning,
    routing: { kind: "static" },
  };
}

function projectSubagents(manifest: CompiledAgentManifest): AgentInfoSubagentEntry[] {
  return manifest.subagents.map((subagent) => {
    const edge = manifest.subagentEdges.find((edge) => edge.childNodeId === subagent.nodeId);
    if (edge === undefined) {
      throw new Error(`Compiled subagent "${subagent.nodeId}" has no parent edge.`);
    }
    // A subagent node reference is not a module binding — the parent binding
    // table never pretends to own a child node. Ownership comes from the
    // child's own config binding: `config.source` for static children and
    // the dynamic config resolver for dynamic children.
    const ownerSourceId =
      subagent.configResolver === undefined
        ? "config" in subagent.agent
          ? (subagent.agent as { config: { source?: { sourceId: string } } }).config.source
              ?.sourceId
          : undefined
        : subagent.configResolver.sourceId;
    if (ownerSourceId === undefined) {
      throw new Error(`Compiled subagent "${subagent.name}" carries no config source reference.`);
    }
    const owner = requireBindingOwner(
      subagent.agent.bindings,
      ownerSourceId,
      `subagent "${subagent.name}"`,
    );

    const entry: AgentInfoSubagentEntry = {
      configResolver:
        subagent.configResolver === undefined
          ? undefined
          : {
              events: [...subagent.configResolver.eventNames],
              ...toSource(
                subagent.configResolver.logicalPath,
                subagent.configResolver.sourceId,
                requireBindingOwner(
                  subagent.agent.bindings,
                  subagent.configResolver.sourceId,
                  `subagent config resolver "${subagent.name}"`,
                ),
              ),
            },
      description: subagent.description,
      name: subagent.name,
      nodeId: subagent.nodeId,
      parentNodeId: edge.parentNodeId,
      source: toSource(subagent.logicalPath, subagent.sourceId, owner),
    };
    return entry;
  });
}

function projectRemoteAgents(
  nodes: readonly { nodeId: string; resources: CompiledAgentResources }[],
): AgentInfoResult["remoteAgents"] {
  const entries: AgentInfoRemoteAgentEntry[] = nodes.flatMap((node) =>
    node.resources.remoteAgents.map((remoteAgent) => ({
      description: remoteAgent.description,
      name: remoteAgent.name,
      nodeId: remoteAgent.nodeId,
      parentNodeId: node.nodeId,
      source: toSource(
        remoteAgent.logicalPath,
        remoteAgent.sourceId,
        requireBindingOwner(
          node.resources.bindings,
          remoteAgent.sourceId,
          `remote agent "${remoteAgent.name}"`,
        ),
      ),
      url: remoteAgent.url,
    })),
  );

  return { entries, total: entries.length };
}

function projectDynamicResolver(
  bindings: NodeBindings,
  resolver: {
    readonly eventNames: readonly string[];
    readonly logicalPath: string;
    readonly slug?: string;
    readonly sourceId: string;
  },
): AgentInfoDynamicResolverEntry {
  return {
    events: [...resolver.eventNames],
    slug: resolver.slug,
    ...toSource(
      resolver.logicalPath,
      resolver.sourceId,
      requireBindingOwner(
        bindings,
        resolver.sourceId,
        `dynamic resolver "${resolver.logicalPath}"`,
      ),
    ),
  };
}

function projectRecordSource(
  bindings: NodeBindings,
  record: {
    readonly logicalPath: string;
    readonly owner?: AgentSourceOwner;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
  what: string,
): AgentInfoSource {
  if (record.sourceKind === "module") {
    return toSource(
      record.logicalPath,
      record.sourceId,
      requireBindingOwner(bindings, record.sourceId, what),
    );
  }
  if (record.owner === undefined) {
    throw new Error(`Compiled ${what} at "${record.logicalPath}" carries no owner.`);
  }
  return toSource(record.logicalPath, record.sourceId, record.owner);
}

function requireBindingOwner(
  bindings: NodeBindings,
  sourceId: string,
  what: string,
): AgentSourceOwner {
  const binding = bindings[sourceId];
  if (binding === undefined) {
    throw new Error(`Compiled ${what} has no binding for source "${sourceId}".`);
  }
  return binding.owner;
}

function projectOwner(owner: AgentSourceOwner): AgentInfoOwner {
  return owner.kind;
}

function toSource(logicalPath: string, sourceId: string, owner: AgentSourceOwner): AgentInfoSource {
  return {
    logicalPath,
    owner: projectOwner(owner),
    sourceId,
  };
}
