import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledRemoteAgentNode,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { HeadersValue } from "#client/types.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import { createResolvedRuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import { createConnectionSearchResolver } from "#runtime/framework-tools/connection-search-dynamic.js";
import {
  getAllFrameworkToolNames,
  getFrameworkToolDefinitions,
} from "#runtime/framework-tools/index.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { resolveAgent } from "#runtime/resolve-agent.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { createRuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import { createRuntimeToolRegistry } from "#runtime/tools/registry.js";
import { CODE_MODE_TOOL_NAME, WORKFLOW_TOOL_NAME } from "#shared/code-mode.js";
import type {
  ResolvedChannelDefinition,
  ResolvedRuntimeDelegationNode,
  ResolvedRuntimeRemoteAgentNode,
  ResolvedRuntimeSubagentNode,
} from "#runtime/types.js";

/**
 * Input for resolving the compiled authored manifest and flattened module graph
 * into a runtime-owned recursive agent graph.
 */
interface ResolveRuntimeAgentGraphInput {
  manifest: CompiledAgentManifest;
  moduleMap: CompiledModuleMap;
}

/**
 * Error raised when the flattened compiled authored graph cannot be hydrated
 * into a runtime-owned agent graph.
 */
class ResolveRuntimeAgentGraphError extends Error {
  readonly logicalPath?: string;
  readonly nodeId?: string;
  readonly sourceId?: string;

  constructor(
    message: string,
    input: {
      logicalPath?: string;
      nodeId?: string;
      sourceId?: string;
    } = {},
  ) {
    super(message);
    this.name = "ResolveRuntimeAgentGraphError";

    if (input.logicalPath !== undefined) {
      this.logicalPath = input.logicalPath;
    }

    if (input.nodeId !== undefined) {
      this.nodeId = input.nodeId;
    }

    if (input.sourceId !== undefined) {
      this.sourceId = input.sourceId;
    }
  }
}

/**
 * Resolves the compiled authored manifest and flattened module graph into one
 * runtime-owned bundle of agent nodes.
 */
export async function resolveRuntimeAgentGraph(
  input: ResolveRuntimeAgentGraphInput,
): Promise<ResolvedAgentGraphBundle> {
  const nodesByNodeId = new Map<string, ResolvedAgentGraphBundle["root"]>();
  const childNodeIdsByParentNodeId = createChildNodeIdsByParentNodeId(input.manifest);
  const subagentNodesById = new Map(
    input.manifest.subagents.map((subagentNode) => [subagentNode.nodeId, subagentNode]),
  );
  const root = await resolveRuntimeAgentNode({
    childNodeIdsByParentNodeId,
    manifest: input.manifest,
    moduleMap: input.moduleMap,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    nodesByNodeId,
    subagentNodesById,
  });

  return {
    nodesByNodeId,
    root,
  };
}

interface ResolveRuntimeAgentNodeInput {
  readonly childNodeIdsByParentNodeId: ReadonlyMap<string, readonly string[]>;
  readonly manifest: CompiledAgentNodeManifest;
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string;
  readonly nodesByNodeId: Map<string, ResolvedAgentGraphBundle["root"]>;
  readonly sourceId?: string;
  readonly subagentNodesById: ReadonlyMap<string, CompiledSubagentNode>;
}

async function resolveRuntimeAgentNode(
  input: ResolveRuntimeAgentNodeInput,
): Promise<ResolvedAgentGraphBundle["root"]> {
  const nodeId = toRuntimeNodeId(input.nodeId);

  if (input.nodesByNodeId.has(nodeId)) {
    throw new ResolveRuntimeAgentGraphError(
      `Found multiple runtime agent nodes for node id "${nodeId}".`,
      {
        nodeId,
        sourceId: input.sourceId,
      },
    );
  }

  const agent = await resolveAgent({
    manifest: input.manifest,
    moduleMap: input.moduleMap,
    nodeId: input.nodeId,
  });
  const hasConnections = agent.connections.length > 0;
  const frameworkTools = getFrameworkToolDefinitions({ hasConnections });
  const frameworkToolNames = new Set(frameworkTools.map((t) => t.name));
  const allFrameworkToolNames = getAllFrameworkToolNames();

  // Authored tools whose filename slug matches a framework default replace
  // it. Authored disable sentinels (whose target is also taken from the
  // file's slug) remove a framework default. Both interactions happen here,
  // before the registry is built, so the duplicate-name guard inside
  // `createRuntimeToolRegistry` keeps doing its job for authored-vs-authored
  // collisions.
  const authoredToolNames = new Set(agent.tools.map((tool) => tool.name));

  for (const disabledName of agent.disabledFrameworkTools) {
    if (!allFrameworkToolNames.has(disabledName)) {
      throw new ResolveRuntimeAgentGraphError(
        `agent/tools/${disabledName}.ts exports disableTool() but "${disabledName}" is not a framework tool. ` +
          `Rename the file to one of: ${[...allFrameworkToolNames].sort().join(", ")}.`,
        {
          nodeId,
          sourceId: input.sourceId,
        },
      );
    }
  }

  const disabledFrameworkTools = new Set(agent.disabledFrameworkTools);
  const activeFrameworkTools = frameworkTools.filter(
    (tool) => !authoredToolNames.has(tool.name) && !disabledFrameworkTools.has(tool.name),
  );

  const toolRegistry = await createRuntimeToolRegistry(
    {
      tools: [...activeFrameworkTools, ...agent.tools],
    },
    {
      reservedToolNames: [
        CODE_MODE_TOOL_NAME,
        WORKFLOW_TOOL_NAME,
        ...(frameworkToolNames.has(LOAD_SKILL_TOOL_NAME) ||
        authoredToolNames.has(LOAD_SKILL_TOOL_NAME)
          ? []
          : [LOAD_SKILL_TOOL_NAME]),
      ],
    },
  );
  // Authored channels override framework defaults by matching logical name;
  // disable sentinels remove framework defaults with the same name.
  const authoredChannelNames = new Set(agent.channels.map((channel) => channel.name));
  const allFrameworkChannelNames = getAllFrameworkChannelNames();

  for (const disabledName of agent.disabledFrameworkChannels) {
    if (!allFrameworkChannelNames.has(disabledName)) {
      throw new ResolveRuntimeAgentGraphError(
        `agent/channels/${disabledName}.ts exports disableRoute() but "${disabledName}" is not a framework channel. ` +
          `Rename the file to one of: ${[...allFrameworkChannelNames].sort().join(", ")}.`,
        {
          nodeId,
          sourceId: input.sourceId,
        },
      );
    }
  }

  const disabledFrameworkChannels = new Set(agent.disabledFrameworkChannels);
  const activeFrameworkChannels = getFrameworkChannelDefinitions().filter(
    (channel) =>
      !authoredChannelNames.has(channel.name) && !disabledFrameworkChannels.has(channel.name),
  );
  const channels: readonly ResolvedChannelDefinition[] = [
    ...activeFrameworkChannels,
    ...agent.channels,
  ];

  const sandboxRegistry = createRuntimeSandboxRegistry({
    authoredSandbox: agent.sandbox,
    workspaceResourceRoot: agent.workspaceResourceRoot,
  });
  const subagentRegistry = createRuntimeSubagentRegistry({
    reservedToolNames: [
      LOAD_SKILL_TOOL_NAME,
      ...toolRegistry.preparedTools.map((tool) => tool.name),
    ],
    subagents: await resolveRuntimeSubagents({
      childNodeIdsByParentNodeId: input.childNodeIdsByParentNodeId,
      manifest: input.manifest,
      moduleMap: input.moduleMap,
      nodesByNodeId: input.nodesByNodeId,
      parentNodeId: input.nodeId,
      subagentNodesById: input.subagentNodesById,
    }),
  });
  const resolvedAgent = hasConnections
    ? {
        ...agent,
        dynamicToolResolvers: [...agent.dynamicToolResolvers, createConnectionSearchResolver()],
      }
    : agent;

  const node: ResolvedAgentGraphBundle["root"] = {
    agent: resolvedAgent,
    channels,
    hookRegistry: createRuntimeHookRegistry(resolvedAgent.hooks),
    nodeId,
    sandboxRegistry,
    sourceId: input.sourceId,
    subagentRegistry,
    toolRegistry,
    turnAgent: createResolvedRuntimeTurnAgent({
      agent: resolvedAgent,
      nodeId,
      tools: [...toolRegistry.preparedTools, ...subagentRegistry.preparedTools],
    }),
  };

  input.nodesByNodeId.set(nodeId, node);

  return node;
}

async function resolveRuntimeSubagents(input: {
  readonly childNodeIdsByParentNodeId: ReadonlyMap<string, readonly string[]>;
  readonly manifest: CompiledAgentNodeManifest;
  readonly moduleMap: CompiledModuleMap;
  readonly nodesByNodeId: Map<string, ResolvedAgentGraphBundle["root"]>;
  readonly parentNodeId: string;
  readonly subagentNodesById: ReadonlyMap<string, CompiledSubagentNode>;
}): Promise<readonly ResolvedRuntimeDelegationNode[]> {
  const resolvedSubagents: ResolvedRuntimeDelegationNode[] = [];
  const childNodeIds = input.childNodeIdsByParentNodeId.get(input.parentNodeId) ?? [];

  for (const childNodeId of childNodeIds) {
    const sourceRef = input.subagentNodesById.get(childNodeId);

    if (sourceRef === undefined) {
      throw new ResolveRuntimeAgentGraphError(
        `Missing compiled subagent node "${childNodeId}" while resolving runtime subagents.`,
        {
          nodeId: toRuntimeNodeId(input.parentNodeId),
          sourceId: childNodeId,
        },
      );
    }

    resolvedSubagents.push(
      await resolveRuntimeSubagent({
        childNodeIdsByParentNodeId: input.childNodeIdsByParentNodeId,
        moduleMap: input.moduleMap,
        nodesByNodeId: input.nodesByNodeId,
        sourceRef,
        subagentNodesById: input.subagentNodesById,
      }),
    );
  }

  for (const remoteAgent of input.manifest.remoteAgents) {
    resolvedSubagents.push(
      await resolveRuntimeRemoteAgent({
        moduleMap: input.moduleMap,
        nodeScopeId: input.parentNodeId,
        sourceRef: remoteAgent,
      }),
    );
  }

  return resolvedSubagents;
}

async function resolveRuntimeSubagent(input: {
  readonly childNodeIdsByParentNodeId: ReadonlyMap<string, readonly string[]>;
  readonly moduleMap: CompiledModuleMap;
  readonly nodesByNodeId: Map<string, ResolvedAgentGraphBundle["root"]>;
  readonly sourceRef: CompiledSubagentNode;
  readonly subagentNodesById: ReadonlyMap<string, CompiledSubagentNode>;
}): Promise<ResolvedRuntimeSubagentNode> {
  const resolvedSubagent: ResolvedRuntimeSubagentNode = {
    description: input.sourceRef.description,
    kind: "subagent",
    logicalPath: input.sourceRef.logicalPath,
    name: input.sourceRef.name,
    nodeId: toRuntimeNodeId(input.sourceRef.nodeId),
    sourceId: input.sourceRef.sourceId,
    sourceKind: "module",
  };
  await resolveRuntimeAgentNode({
    childNodeIdsByParentNodeId: input.childNodeIdsByParentNodeId,
    manifest: input.sourceRef.agent,
    moduleMap: input.moduleMap,
    nodeId: input.sourceRef.nodeId,
    nodesByNodeId: input.nodesByNodeId,
    sourceId: input.sourceRef.sourceId,
    subagentNodesById: input.subagentNodesById,
  });

  return resolvedSubagent;
}

async function resolveRuntimeRemoteAgent(input: {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeScopeId: string;
  readonly sourceRef: CompiledRemoteAgentNode;
}): Promise<ResolvedRuntimeRemoteAgentNode> {
  const resolvedExportValue = await loadResolvedModuleExport({
    definition: input.sourceRef,
    kindLabel: "remote agent",
    moduleMap: input.moduleMap,
    nodeId: input.nodeScopeId,
  });
  const resolvedRecord = expectObjectRecord(
    resolvedExportValue,
    `Expected remote agent source "${input.sourceRef.logicalPath}" to export an object.`,
  );

  const resolvedRemoteAgent: {
    auth?: ResolvedRuntimeRemoteAgentNode["auth"];
    description: string;
    headers?: HeadersValue;
    kind: "remote";
    logicalPath: string;
    name: string;
    nodeId: string;
    outputSchema?: ResolvedRuntimeRemoteAgentNode["outputSchema"];
    path: string;
    sourceId: string;
    sourceKind: "module";
    url: string;
  } = {
    description: input.sourceRef.description,
    kind: "remote",
    logicalPath: input.sourceRef.logicalPath,
    name: input.sourceRef.name,
    nodeId: toRuntimeNodeId(input.sourceRef.nodeId),
    outputSchema: input.sourceRef.outputSchema,
    path: input.sourceRef.path,
    sourceId: input.sourceRef.sourceId,
    sourceKind: "module",
    url: input.sourceRef.url,
  };

  if (typeof resolvedRecord.auth === "function") {
    resolvedRemoteAgent.auth = resolvedRecord.auth as ResolvedRuntimeRemoteAgentNode["auth"];
  }

  const headers = resolveRemoteAgentHeaders(resolvedRecord.headers);

  if (headers !== undefined) {
    resolvedRemoteAgent.headers = headers;
  }

  return resolvedRemoteAgent;
}

function resolveRemoteAgentHeaders(value: unknown): HeadersValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "function") {
    return value as HeadersValue;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      headers[headerName] = headerValue;
    }
  }

  return headers;
}

function createChildNodeIdsByParentNodeId(
  manifest: CompiledAgentManifest,
): ReadonlyMap<string, readonly string[]> {
  const childNodeIdsByParentNodeId = new Map<string, string[]>();

  for (const edge of manifest.subagentEdges) {
    const existing = childNodeIdsByParentNodeId.get(edge.parentNodeId);

    if (existing === undefined) {
      childNodeIdsByParentNodeId.set(edge.parentNodeId, [edge.childNodeId]);
      continue;
    }

    existing.push(edge.childNodeId);
  }

  return childNodeIdsByParentNodeId;
}

function toRuntimeNodeId(nodeId: string): string {
  return nodeId === ROOT_COMPILED_AGENT_NODE_ID ? ROOT_RUNTIME_AGENT_NODE_ID : nodeId;
}
