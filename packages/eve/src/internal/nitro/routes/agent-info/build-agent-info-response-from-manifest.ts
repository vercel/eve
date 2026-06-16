import {
  getAllFrameworkToolNames,
  getFrameworkToolDefinitions,
} from "#runtime/framework-tools/index.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import { createConnectionSearchResolver } from "#runtime/framework-tools/connection-search-dynamic.js";
import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { ResolvedChannelDefinition, ResolvedToolDefinition } from "#runtime/types.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { CODE_MODE_TOOL_NAME, WORKFLOW_TOOL_NAME } from "#shared/code-mode.js";
import type {
  AgentInfoFrameworkChannelEntry,
  AgentInfoFrameworkToolEntry,
  AgentInfoResponse,
} from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  renderChannel,
  renderDynamicResolver,
  renderSchedule,
  renderSubagent,
  renderTool,
  toSource,
} from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";

export function buildAgentInfoResponseFromManifest(
  data: AgentInfoManifestData,
  input: {
    readonly mode: AgentInfoResponse["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
  },
): AgentInfoResponse {
  const manifest = data.manifest;
  const authoredChannels = manifest.channels.filter((channel) => channel.kind === "channel");
  const disabledFrameworkChannels = manifest.channels
    .filter((channel) => channel.kind === "disabled")
    .map((channel) => channel.name);
  const authoredToolNames = new Set(manifest.tools.map((tool) => tool.name));
  const disabledFrameworkTools = new Set(manifest.disabledFrameworkTools);
  const allFrameworkToolNames = getAllFrameworkToolNames();
  const allFrameworkChannelNames = getAllFrameworkChannelNames();
  const frameworkToolDefinitions = getFrameworkToolDefinitions({
    hasConnections: manifest.connections.length > 0,
  });
  const frameworkChannelDefinitions = getFrameworkChannelDefinitions();
  const activeFrameworkTools = frameworkToolDefinitions.filter(
    (tool) => !authoredToolNames.has(tool.name) && !disabledFrameworkTools.has(tool.name),
  );
  const authoredTools = manifest.tools.map((tool) => ({
    ...toSource(tool),
    description: tool.description,
    hasAuth: false,
    hasCompactionHook: false,
    hasExecute: true,
    hasModelOutputProjection: false,
    hasOutputSchema: tool.outputSchema !== undefined && tool.outputSchema !== null,
    inputSchema: tool.inputSchema,
    name: tool.name,
    origin: "authored" as const,
    outputSchema: tool.outputSchema ?? null,
    replacesFrameworkTool: allFrameworkToolNames.has(tool.name),
    requiresApproval: false,
  }));
  const authoredChannelNames = new Set(authoredChannels.map((channel) => channel.name));
  const disabledFrameworkChannelNames = new Set(disabledFrameworkChannels);
  const activeFrameworkChannels = frameworkChannelDefinitions.filter(
    (channel) =>
      !authoredChannelNames.has(channel.name) && !disabledFrameworkChannelNames.has(channel.name),
  );
  const renderedAuthoredChannels = authoredChannels.map((channel) => ({
    ...toSource(channel),
    adapterKind: channel.adapterKind,
    method: channel.method,
    name: channel.name,
    origin: "authored" as const,
    urlPath: channel.urlPath,
  }));

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      configSource: manifest.config.source ? toSource(manifest.config.source) : undefined,
      description: manifest.config.description,
      model: {
        contextWindowTokens: manifest.config.model.contextWindowTokens,
        id: manifest.config.model.id,
        providerOptions: manifest.config.model.providerOptions,
        source: manifest.config.model.source ? toSource(manifest.config.model.source) : undefined,
        routing: manifest.config.model.routing,
        endpoint: resolveModelEndpointStatus(
          manifest.config.model.routing,
          input.gatewayCredentials,
        ),
      },
      name: manifest.config.name,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: {
      devRoutes: input.mode === "development",
    },
    channels: {
      authored: renderedAuthoredChannels,
      available: [
        ...activeFrameworkChannels.map((channel) =>
          renderChannel(channel as ResolvedChannelDefinition, {
            origin: "framework",
          }),
        ),
        ...renderedAuthoredChannels,
      ],
      disabledFramework: disabledFrameworkChannels,
      framework: frameworkChannelDefinitions
        .filter((channel) => allFrameworkChannelNames.has(channel.name))
        .map((channel) => {
          const replacedByAuthoredChannel = authoredChannelNames.has(channel.name);
          const disabledByAuthor = disabledFrameworkChannelNames.has(channel.name);
          const status: AgentInfoFrameworkChannelEntry["status"] = disabledByAuthor
            ? "disabled"
            : replacedByAuthoredChannel
              ? "replaced"
              : "active";

          return {
            ...renderChannel(channel as ResolvedChannelDefinition, {
              origin: "framework",
            }),
            disabledByAuthor,
            replacedByAuthoredChannel,
            status,
          };
        }),
    },
    connections: manifest.connections.map((connection) => ({
      ...toSource(connection),
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
      ...toSource(hook),
      eventNames: [],
      slug: hook.slug,
    })),
    instructions: {
      dynamic: manifest.dynamicInstructions.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
      static:
        manifest.instructions === undefined
          ? null
          : {
              ...toSource(manifest.instructions),
              markdown: manifest.instructions.markdown,
              name: manifest.instructions.name,
            },
    },
    kind: "eve-agent-info",
    mode: input.mode,
    sandbox:
      manifest.sandbox === null
        ? null
        : {
            ...toSource(manifest.sandbox),
            description: manifest.sandbox.description,
            hasBootstrap: false,
            hasOnSession: false,
            revalidationKey: manifest.sandbox.revalidationKey,
            sourceHash: manifest.sandbox.sourceHash,
          },
    schedules: data.schedules.map(renderSchedule),
    skills: {
      static: manifest.skills.map((skill) => ({
        ...toSource(skill),
        description: skill.description,
        license: skill.license,
        markdown: skill.markdown,
        metadata: skill.metadata,
        name: skill.name,
      })),
      dynamic: manifest.dynamicSkills.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
    },
    subagents: {
      local: manifest.subagents.map(renderSubagent),
      total: manifest.subagents.length,
    },
    tools: {
      available: [
        ...activeFrameworkTools.map((tool) =>
          renderTool(tool as ResolvedToolDefinition, {
            origin: "framework",
            replacesFrameworkTool: false,
          }),
        ),
        ...authoredTools,
      ],
      authored: authoredTools,
      disabledFramework: [...manifest.disabledFrameworkTools],
      dynamic: [
        ...(manifest.connections.length > 0
          ? [renderDynamicResolver(createConnectionSearchResolver(), { origin: "framework" })]
          : []),
        ...manifest.dynamicTools.map((resolver) =>
          renderDynamicResolver(resolver, { origin: "authored" }),
        ),
      ],
      framework: frameworkToolDefinitions.map((tool) => {
        const replacedByAuthoredTool = authoredToolNames.has(tool.name);
        const disabledByAuthor = disabledFrameworkTools.has(tool.name);
        const status: AgentInfoFrameworkToolEntry["status"] = disabledByAuthor
          ? "disabled"
          : replacedByAuthoredTool
            ? "replaced"
            : "active";

        return {
          ...renderTool(tool as ResolvedToolDefinition, {
            origin: "framework",
            replacesFrameworkTool: false,
          }),
          disabledByAuthor,
          replacedByAuthoredTool,
          status,
        };
      }),
      reserved: [CODE_MODE_TOOL_NAME, WORKFLOW_TOOL_NAME, LOAD_SKILL_TOOL_NAME],
    },
    version: 1,
    workflow: {
      enabled: manifest.workflowEnabled,
      toolName: WORKFLOW_TOOL_NAME,
    },
    workspace: {
      resourceRoot: manifest.workspaceResourceRoot,
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}
