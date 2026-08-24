import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledDynamicInstructionsDefinition,
  CompiledDynamicSkillDefinition,
  CompiledDynamicToolDefinition,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { AgentSourceOwner, CompiledModuleBinding } from "#compiler/source-graph.js";
import type { AgentInfoResult, AgentInfoSource } from "#client/agent-info-schema.js";
import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";

export type AgentInfoResponse = AgentInfoResult;

function toChatGptEndpoint(state: ChatGptAuthState | undefined) {
  if (state === undefined) return undefined;
  const endpoint = { state: state.kind };
  if (state.kind === "ready" && state.accountLabel !== undefined) {
    return { ...endpoint, accountLabel: state.accountLabel };
  }
  return endpoint;
}

/** Projects v3 exclusively from the effective compiled graph. */
export function buildAgentInfoResponse(
  data: AgentInfoManifestData,
  input: {
    readonly mode: AgentInfoResponse["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
  },
): AgentInfoResponse {
  const { manifest } = data;
  const configSource = toModuleSource(manifest, manifest.config.source);
  if (configSource.binding === undefined) {
    throw new Error(`Compiled config source "${manifest.config.source.sourceId}" has no binding.`);
  }
  const composition = collectCompositionDiagnostics(manifest);
  const remoteAgents = collectRemoteAgents(manifest);

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      config: { ...configSource, binding: configSource.binding },
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
                resolver: renderDynamicResolver(manifest, {
                  ...manifest.config.dynamicModel,
                  slug: "model",
                }),
              },
            },
      name: manifest.config.name,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: { devRoutes: input.mode === "development" },
    channels: {
      routes: manifest.channelRoutes.effective.map((route) => ({
        ...toModuleSource(manifest, route),
        adapterKind: route.adapterKind,
        method: route.method,
        name: route.name,
        urlPath: route.urlPath,
      })),
      shadowed: [...manifest.channelRoutes.shadowed],
    },
    composition,
    connections: manifest.connections.map((connection) => ({
      ...toModuleSource(manifest, connection),
      connectionName: connection.connectionName,
      description: connection.description,
      hasApproval: false,
      hasAuthorization: connection.vercelConnect !== undefined,
      hasHeaders: false,
      protocol: connection.protocol,
      url: connection.url,
    })),
    diagnostics: {
      discoveryErrors: manifest.diagnosticsSummary.errors,
      discoveryWarnings: manifest.diagnosticsSummary.warnings,
    },
    hooks: manifest.hooks.map((hook) => ({
      ...toModuleSource(manifest, hook),
      eventNames: [...hook.eventNames],
      slug: hook.slug,
    })),
    instructions: {
      dynamic: manifest.dynamicInstructions.map((resolver) =>
        renderDynamicResolver(manifest, resolver),
      ),
      static: manifest.instructions.map((definition) => ({
        ...toOwnedSource(manifest, definition),
        content: definition.content,
        name: definition.name,
        role: definition.role,
      })),
    },
    instrumentation:
      manifest.instrumentation === undefined
        ? undefined
        : toModuleSource(manifest, manifest.instrumentation),
    kernelEffects: projectPreparedKernelEffects(manifest),
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
      hasBootstrap: false,
      hasOnSession: false,
      revalidationKey: manifest.sandbox.revalidationKey,
      sourceHash: manifest.sandbox.sourceHash,
    },
    schedules: manifest.schedules.map((schedule) => ({
      ...toOwnedSource(manifest, schedule),
      cron: schedule.cron,
      hasRun: schedule.hasRun,
      markdown: schedule.markdown,
      name: schedule.name,
    })),
    skills: {
      dynamic: manifest.dynamicSkills.map((resolver) => renderDynamicResolver(manifest, resolver)),
      static: manifest.skills.map((skill) => ({
        ...toOwnedSource(manifest, skill),
        description: skill.description,
        license: skill.license,
        markdown: skill.markdown,
        metadata: skill.metadata,
        name: skill.name,
      })),
    },
    subagents: {
      local: manifest.subagents.map((subagent) => {
        const projected = {
          ...toOwnedSource(manifest, subagent),
          description: subagent.description,
          entryPath: subagent.entryPath,
          name: subagent.name,
          nodeId: subagent.nodeId,
          parentNodeId: subagent.parentNodeId,
          rootPath: subagent.rootPath,
          summary: summarizeNode(subagent.agent),
        };
        if (subagent.configResolver === undefined) return projected;
        return {
          ...projected,
          configResolver: renderDynamicResolver(subagent.agent, {
            ...subagent.configResolver,
            slug: "config",
          }),
        };
      }),
      total: manifest.subagents.length,
    },
    tools: {
      dynamic: manifest.dynamicTools.map((resolver) => renderDynamicResolver(manifest, resolver)),
      static: manifest.tools.map((tool) => ({
        ...toModuleSource(manifest, tool),
        description: tool.description,
        hasAuth: false,
        hasExecute: tool.hasExecute,
        hasModelOutputProjection: tool.hasModelOutputProjection,
        hasOutputSchema: tool.outputSchema !== undefined,
        inputSchema: tool.inputSchema,
        name: tool.name,
        outputSchema: tool.outputSchema,
        requiresApproval: tool.requiresApproval,
      })),
    },
    version: 3,
    workflow:
      manifest.workflowTool === undefined
        ? { enabled: false, toolName: WORKFLOW_TOOL_NAME }
        : {
            enabled: true,
            source: toModuleSource(manifest, manifest.workflowTool),
            toolName: WORKFLOW_TOOL_NAME,
          },
    workspace: {
      resourceRoot: manifest.workspaceResourceRoot,
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}

function toModuleSource(
  node: CompiledAgentNodeManifest | CompiledAgentResources,
  source: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
): AgentInfoSource {
  const binding = node.bindings[source.sourceId];
  if (binding === undefined) {
    throw new Error(`Compiled source "${source.sourceId}" has no binding.`);
  }
  return sourceProjection(source, binding.owner, binding);
}

function toOwnedSource(
  node: CompiledAgentNodeManifest | CompiledAgentResources,
  source: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly owner?: AgentSourceOwner;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
): AgentInfoSource {
  const binding = node.bindings[source.sourceId];
  const owner = binding?.owner ?? source.owner;
  if (owner === undefined) {
    throw new Error(`Compiled source "${source.sourceId}" has no owner.`);
  }
  return sourceProjection(source, owner, binding);
}

function sourceProjection(
  source: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
  owner: AgentSourceOwner,
  binding?: CompiledModuleBinding,
): AgentInfoSource {
  const projected = {
    logicalPath: source.logicalPath,
    owner,
    sourceId: source.sourceId,
    sourceKind: toAgentInfoSourceKind(source.sourceKind),
  };
  if (binding !== undefined && source.exportName !== undefined) {
    return { ...projected, binding, exportName: source.exportName };
  }
  if (binding !== undefined) return { ...projected, binding };
  if (source.exportName !== undefined) return { ...projected, exportName: source.exportName };
  return projected;
}

function toAgentInfoSourceKind(sourceKind: string): AgentInfoSource["sourceKind"] {
  switch (sourceKind) {
    case "markdown":
    case "module":
    case "skill-package":
      return sourceKind;
    default:
      throw new Error(`Unsupported compiled source kind "${sourceKind}".`);
  }
}

function renderDynamicResolver(
  node: CompiledAgentNodeManifest | CompiledAgentResources,
  resolver:
    | CompiledDynamicInstructionsDefinition
    | CompiledDynamicSkillDefinition
    | CompiledDynamicToolDefinition
    | {
        readonly eventNames: readonly string[];
        readonly exportName?: string;
        readonly logicalPath: string;
        readonly slug: string;
        readonly sourceId: string;
        readonly sourceKind: "module";
      },
) {
  return {
    ...toModuleSource(node, resolver),
    eventNames: [...resolver.eventNames],
    slug: resolver.slug,
  };
}

function summarizeNode(node: CompiledAgentNodeManifest | CompiledAgentResources) {
  return {
    channels: node.channelRoutes.effective.length,
    connections: node.connections.length,
    hooks: node.hooks.length,
    instructions: node.instructions.length,
    schedules: node.schedules.length,
    skills: node.skills.length,
    tools: node.tools.length,
  };
}

function collectRemoteAgents(manifest: CompiledAgentManifest) {
  return [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].flatMap((node) =>
    node.remoteAgents.map((remote) => ({
      ...sourceProjection(remote, remote.owner, remote.binding),
      description: remote.description,
      name: remote.name,
      nodeId: remote.nodeId,
      parentNodeId: remote.parentNodeId,
      url: remote.url,
    })),
  );
}

function collectCompositionDiagnostics(manifest: CompiledAgentManifest) {
  const entries = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].flatMap(
    (node) => node.sourceComposition.entries,
  );
  const projected = entries.map((entry) => {
    const diagnostic = {
      kind: entry.kind,
      logicalPath: entry.source.logicalPath,
      owner: entry.source.owner,
      sourceId: entry.source.sourceId,
    };
    if (entry.kind === "shadowed") {
      return { ...diagnostic, winnerSourceId: entry.winnerSourceId };
    }
    return diagnostic;
  });
  return {
    disabled: projected.filter((entry) => entry.kind === "disabled"),
    shadowed: projected.filter((entry) => entry.kind === "shadowed"),
  };
}

const KERNEL_EFFECT_BY_SLOT = {
  "tools/agent": { action: "subagent-call", audience: ["root-session"], kind: "dispatch" },
  "tools/ask_question": {
    audience: ["requires-request-input"],
    kind: "request-input",
  },
  "tools/task_cancel": { action: "task-cancel", audience: ["root-session"], kind: "dispatch" },
  "tools/task_update": {
    action: "task-update",
    audience: ["delegated-task-child"],
    kind: "dispatch",
  },
  "tools/web_search": { audience: [], kind: "provider-tool" },
} as const;

function projectPreparedKernelEffects(manifest: CompiledAgentManifest) {
  return manifest.tools.flatMap((tool) => {
    const binding = manifest.bindings[tool.sourceId];
    const slot = tool.logicalPath.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    const effect = KERNEL_EFFECT_BY_SLOT[slot as keyof typeof KERNEL_EFFECT_BY_SLOT];
    const isAuthoredWebSearch =
      slot === "tools/web_search" && manifest.webSearchProvider !== undefined;
    if (binding?.owner.kind !== "framework" && !isAuthoredWebSearch) return [];
    return effect === undefined ? [] : [{ ...effect, sourceId: tool.sourceId }];
  });
}
