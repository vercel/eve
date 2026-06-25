import {
  getAllFrameworkToolNames,
  getFrameworkToolDefinitions,
} from "#runtime/framework-tools/index.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import { createConnectionSearchResolver } from "#runtime/framework-tools/connection-search-dynamic.js";
import type {
  AgentInfoData,
  CompiledSubagentNode,
  ResolvedSandboxDefinition,
  ResolvedSchedule,
  ResolvedSkillDefinition,
} from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type {
  ResolvedAgent,
  ResolvedChannelDefinition,
  ResolvedToolDefinition,
} from "#runtime/types.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface AgentInfoSource {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId?: string;
  readonly sourceKind: string;
}

export interface AgentInfoToolEntry extends AgentInfoSource {
  readonly description: string;
  readonly hasAuth: boolean;
  readonly hasExecute: boolean;
  readonly hasModelOutputProjection: boolean;
  readonly hasOutputSchema: boolean;
  readonly inputSchema: unknown;
  readonly name: string;
  readonly origin: "authored" | "framework";
  readonly outputSchema: unknown;
  readonly replacesFrameworkTool: boolean;
  readonly requiresApproval: boolean;
}

export interface AgentInfoFrameworkToolEntry extends AgentInfoToolEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredTool: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoDynamicResolverEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly origin: "authored" | "framework";
  readonly slug: string;
}

export interface AgentInfoTools {
  readonly available: readonly AgentInfoToolEntry[];
  readonly authored: readonly AgentInfoToolEntry[];
  readonly disabledFramework: readonly string[];
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly framework: readonly AgentInfoFrameworkToolEntry[];
  readonly reserved: readonly string[];
}

export interface AgentInfoSkillEntry extends AgentInfoSource {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name: string;
}

export interface AgentInfoInstructionsEntry extends AgentInfoSource {
  readonly markdown: string;
  readonly name: string;
}

export interface AgentInfoInstructions {
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly static: AgentInfoInstructionsEntry | null;
}

export interface AgentInfoScheduleEntry extends AgentInfoSource {
  readonly cron: string;
  readonly hasRun: boolean;
  readonly markdown?: string;
  readonly name: string;
}

export interface AgentInfoSubagentEntry extends AgentInfoSource {
  readonly description: string;
  readonly entryPath: string;
  readonly name: string;
  readonly nodeId: string;
  readonly rootPath: string;
  readonly summary: {
    readonly channels: number;
    readonly connections: number;
    readonly hooks: number;
    readonly instructions: boolean;
    readonly schedules: number;
    readonly skills: number;
    readonly tools: number;
  };
}

export interface AgentInfoChannelEntry extends AgentInfoSource {
  readonly adapterKind?: string;
  readonly method: string;
  readonly name: string;
  readonly origin: "authored" | "framework";
  readonly urlPath: string;
}

export interface AgentInfoFrameworkChannelEntry extends AgentInfoChannelEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredChannel: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoChannels {
  readonly authored: readonly AgentInfoChannelEntry[];
  readonly available: readonly AgentInfoChannelEntry[];
  readonly disabledFramework: readonly string[];
  readonly framework: readonly AgentInfoFrameworkChannelEntry[];
}

export interface AgentInfoConnectionEntry extends AgentInfoSource {
  readonly connectionName: string;
  readonly description: string;
  readonly hasApproval: boolean;
  readonly hasAuthorization: boolean;
  readonly hasHeaders: boolean;
  readonly protocol: string;
  readonly toolFilter?: unknown;
  readonly url: string;
}

export interface AgentInfoHookEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly slug: string;
}

export interface AgentInfoSandboxEntry extends AgentInfoSource {
  readonly backendKind?: string;
  readonly description?: string;
  readonly hasBootstrap: boolean;
  readonly hasOnSession: boolean;
  readonly revalidationKey?: string;
  readonly sourceHash?: string;
}

export interface AgentInfoDiagnostics {
  readonly discoveryErrors: number;
  readonly discoveryWarnings: number;
}

export interface AgentInfoResponse {
  readonly agent: {
    readonly agentRoot: string;
    readonly appRoot: string;
    readonly configSource?: AgentInfoSource;
    readonly description?: string;
    readonly model: {
      readonly contextWindowTokens?: number;
      readonly id: string;
      readonly providerOptions?: unknown;
      readonly source?: AgentInfoSource;
      readonly routing?: ModelRouting;
      readonly endpoint?: ModelEndpointStatus;
    };
    readonly name: string;
    readonly outputSchema?: unknown;
  };
  readonly capabilities: {
    readonly devRoutes: boolean;
  };
  readonly channels: AgentInfoChannels;
  readonly connections: readonly AgentInfoConnectionEntry[];
  readonly diagnostics: AgentInfoDiagnostics;
  readonly hooks: readonly AgentInfoHookEntry[];
  readonly instructions: AgentInfoInstructions;
  readonly kind: "eve-agent-info";
  readonly mode: "development" | "production";
  readonly sandbox: AgentInfoSandboxEntry | null;
  readonly schedules: readonly AgentInfoScheduleEntry[];
  readonly skills: {
    readonly static: readonly AgentInfoSkillEntry[];
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  };
  readonly subagents: {
    readonly local: readonly AgentInfoSubagentEntry[];
    readonly total: number;
  };
  readonly tools: AgentInfoTools;
  readonly version: 1;
  readonly workflow: {
    readonly enabled: boolean;
    readonly toolName: string;
  };
  readonly workspace: {
    readonly resourceRoot: unknown;
    readonly rootEntries: readonly string[];
  };
}

export function buildAgentInfoResponse(
  data: AgentInfoData,
  input: {
    readonly mode: AgentInfoResponse["mode"];
  },
): AgentInfoResponse {
  const agent = data.agent;
  const tools = buildToolInfo(agent);

  return {
    agent: {
      agentRoot: agent.metadata.agentRoot,
      appRoot: agent.metadata.appRoot,
      configSource: agent.config.source ? toSource(agent.config.source) : undefined,
      description: agent.config.description,
      model: {
        contextWindowTokens: agent.config.model.contextWindowTokens,
        id: agent.config.model.id,
        providerOptions: agent.config.model.providerOptions,
        source: agent.config.model.source ? toSource(agent.config.model.source) : undefined,
      },
      name: agent.config.name,
      outputSchema: agent.config.outputSchema,
    },
    capabilities: {
      devRoutes: input.mode === "development",
    },
    channels: buildChannelInfo(agent),
    connections: agent.connections.map((connection) => ({
      ...toSource(connection),
      connectionName: connection.connectionName,
      description: connection.description,
      hasApproval: connection.approval !== undefined,
      hasAuthorization: connection.authorization !== undefined,
      hasHeaders: connection.headers !== undefined,
      protocol: connection.protocol,
      toolFilter: connection.tools,
      url: connection.url,
    })),
    diagnostics: {
      discoveryErrors: agent.metadata.diagnosticsSummary.errors,
      discoveryWarnings: agent.metadata.diagnosticsSummary.warnings,
    },
    hooks: agent.hooks.map((hook) => ({
      ...toSource(hook),
      eventNames: Object.keys(hook.events).sort(),
      slug: hook.slug,
    })),
    instructions: {
      dynamic: agent.dynamicInstructionsResolvers.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
      static: agent.instructions
        ? {
            ...toSource(agent.instructions),
            markdown: agent.instructions.markdown,
            name: agent.instructions.name,
          }
        : null,
    },
    kind: "eve-agent-info",
    mode: input.mode,
    sandbox: renderSandbox(agent.sandbox),
    schedules: data.schedules.map(renderSchedule),
    skills: {
      static: agent.skills.map(renderSkill),
      dynamic: agent.dynamicSkillResolvers.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
    },
    subagents: {
      local: data.manifest.subagents.map(renderSubagent),
      total: data.manifest.subagents.length,
    },
    tools,
    version: 1,
    workflow: {
      enabled: agent.workflowEnabled,
      toolName: WORKFLOW_TOOL_NAME,
    },
    workspace: {
      resourceRoot: agent.workspaceResourceRoot,
      rootEntries: [...agent.workspaceSpec.rootEntries],
    },
  };
}

function buildChannelInfo(agent: ResolvedAgent): AgentInfoChannels {
  const authoredChannelNames = new Set(agent.channels.map((channel) => channel.name));
  const disabledFrameworkChannels = new Set(agent.disabledFrameworkChannels);
  const allFrameworkChannelNames = getAllFrameworkChannelNames();
  const frameworkChannelDefinitions = getFrameworkChannelDefinitions();
  const activeFrameworkChannels = frameworkChannelDefinitions.filter(
    (channel) =>
      !authoredChannelNames.has(channel.name) && !disabledFrameworkChannels.has(channel.name),
  );
  const authored = agent.channels.map((channel) =>
    renderChannel(channel, {
      origin: "authored",
    }),
  );
  const framework = frameworkChannelDefinitions.map((channel) => {
    const replacedByAuthoredChannel = authoredChannelNames.has(channel.name);
    const disabledByAuthor = disabledFrameworkChannels.has(channel.name);
    const status: AgentInfoFrameworkChannelEntry["status"] = disabledByAuthor
      ? "disabled"
      : replacedByAuthoredChannel
        ? "replaced"
        : "active";

    return {
      ...renderChannel(channel, {
        origin: "framework",
      }),
      disabledByAuthor,
      replacedByAuthoredChannel,
      status,
    };
  });

  return {
    authored,
    available: [
      ...activeFrameworkChannels.map((channel) =>
        renderChannel(channel, {
          origin: "framework",
        }),
      ),
      ...authored,
    ],
    disabledFramework: [...agent.disabledFrameworkChannels],
    framework: framework.filter((channel) => allFrameworkChannelNames.has(channel.name)),
  };
}

function buildToolInfo(agent: ResolvedAgent): AgentInfoTools {
  const authoredToolNames = new Set(agent.tools.map((tool) => tool.name));
  const disabledFrameworkTools = new Set(agent.disabledFrameworkTools);
  const allFrameworkToolNames = getAllFrameworkToolNames();
  const frameworkToolDefinitions = getFrameworkToolDefinitions({
    hasConnections: agent.connections.length > 0,
  });
  const dynamicFrameworkResolvers =
    agent.connections.length > 0 ? [createConnectionSearchResolver()] : [];
  const activeFrameworkTools = frameworkToolDefinitions.filter(
    (tool) => !authoredToolNames.has(tool.name) && !disabledFrameworkTools.has(tool.name),
  );
  const authored = agent.tools.map((tool) =>
    renderTool(tool, {
      origin: "authored",
      replacesFrameworkTool: allFrameworkToolNames.has(tool.name),
    }),
  );
  const framework = frameworkToolDefinitions.map((tool) => {
    const replacedByAuthoredTool = authoredToolNames.has(tool.name);
    const disabledByAuthor = disabledFrameworkTools.has(tool.name);
    const status: AgentInfoFrameworkToolEntry["status"] = disabledByAuthor
      ? "disabled"
      : replacedByAuthoredTool
        ? "replaced"
        : "active";

    return {
      ...renderTool(tool, {
        origin: "framework",
        replacesFrameworkTool: false,
      }),
      disabledByAuthor,
      replacedByAuthoredTool,
      status,
    };
  });

  return {
    available: [
      ...activeFrameworkTools.map((tool) =>
        renderTool(tool, {
          origin: "framework",
          replacesFrameworkTool: false,
        }),
      ),
      ...authored,
    ],
    authored,
    disabledFramework: [...agent.disabledFrameworkTools],
    dynamic: [
      ...dynamicFrameworkResolvers.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "framework" }),
      ),
      ...agent.dynamicToolResolvers.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
    ],
    framework,
    reserved: [WORKFLOW_TOOL_NAME, LOAD_SKILL_TOOL_NAME],
  };
}

export function renderChannel(
  channel: ResolvedChannelDefinition,
  input: {
    readonly origin: "authored" | "framework";
  },
): AgentInfoChannelEntry {
  return {
    ...toSource(channel),
    adapterKind: channel.adapter?.kind,
    method: channel.method,
    name: channel.name,
    origin: input.origin,
    urlPath: channel.urlPath,
  };
}

export function renderTool(
  tool: ResolvedToolDefinition,
  input: {
    readonly origin: "authored" | "framework";
    readonly replacesFrameworkTool: boolean;
  },
): AgentInfoToolEntry {
  return {
    ...toSource(tool),
    description: tool.description,
    hasAuth: false,
    hasExecute: tool.execute !== undefined,
    hasModelOutputProjection: tool.toModelOutput !== undefined,
    hasOutputSchema: tool.outputSchema !== undefined && tool.outputSchema !== null,
    inputSchema: tool.inputSchema,
    name: tool.name,
    origin: input.origin,
    outputSchema: tool.outputSchema,
    replacesFrameworkTool: input.replacesFrameworkTool,
    requiresApproval: tool.approval !== undefined,
  };
}

function renderSkill(skill: ResolvedSkillDefinition): AgentInfoSkillEntry {
  return {
    ...toSource(skill),
    description: skill.description,
    license: skill.license,
    markdown: skill.markdown,
    metadata: skill.metadata,
    name: skill.name,
  };
}

export function renderSchedule(schedule: ResolvedSchedule): AgentInfoScheduleEntry {
  return {
    ...toSource(schedule),
    cron: schedule.cron,
    hasRun: schedule.hasRun,
    markdown: schedule.markdown,
    name: schedule.name,
  };
}

function renderSandbox(sandbox: ResolvedSandboxDefinition | null): AgentInfoSandboxEntry | null {
  if (sandbox === null) {
    return null;
  }

  return {
    ...toSource(sandbox),
    backendKind: resolveBackendKind(sandbox.backend),
    description: sandbox.description,
    hasBootstrap: sandbox.bootstrap !== undefined,
    hasOnSession: sandbox.onSession !== undefined,
    revalidationKey: sandbox.revalidationKey,
    sourceHash: sandbox.sourceHash,
  };
}

export function renderSubagent(subagent: CompiledSubagentNode): AgentInfoSubagentEntry {
  return {
    ...toSource(subagent),
    description: subagent.description,
    entryPath: subagent.entryPath,
    name: subagent.name,
    nodeId: subagent.nodeId,
    rootPath: subagent.rootPath,
    summary: {
      channels: subagent.agent.channels.length,
      connections: subagent.agent.connections.length,
      hooks: subagent.agent.hooks.length,
      instructions: subagent.agent.instructions !== undefined,
      schedules: subagent.agent.schedules.length,
      skills: subagent.agent.skills.length,
      tools: subagent.agent.tools.length,
    },
  };
}

export function renderDynamicResolver(
  resolver: {
    readonly eventNames: readonly string[];
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly slug: string;
    readonly sourceId: string;
    readonly sourceKind: string;
  },
  input: {
    readonly origin: "authored" | "framework";
  },
): AgentInfoDynamicResolverEntry {
  return {
    ...toSource(resolver),
    eventNames: [...resolver.eventNames],
    origin: input.origin,
    slug: resolver.slug,
  };
}

export function toSource(source: {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId?: string;
  readonly sourceKind: string;
}): AgentInfoSource {
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };
}

function resolveBackendKind(backend: unknown): string | undefined {
  if (backend === null || typeof backend !== "object") {
    return undefined;
  }

  const kind = (backend as { readonly kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}
