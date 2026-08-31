import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledRemoteAgentNode,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { validateCompiledModuleMap } from "#compiler/validate-artifact.js";
import type { HeadersValue } from "#client/types.js";
import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import { createResolvedRuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { resolveAgent } from "#runtime/resolve-agent.js";
import { resolveDynamicSubagentDefinition } from "#runtime/resolve-dynamic-subagent.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { createRuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import { createRuntimeToolRegistry } from "#runtime/tools/registry.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type {
  ResolvedDynamicSubagentDefinition,
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
  validateCompiledModuleMap(input.manifest, input.moduleMap);
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
  attachInheritedSandboxWorkspaceResources({
    manifest: input.manifest,
    nodesByNodeId,
  });

  return {
    nodesByNodeId,
    root,
  };
}

interface ResolveRuntimeAgentNodeInput {
  readonly childNodeIdsByParentNodeId: ReadonlyMap<string, readonly string[]>;
  readonly agentId?: string;
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
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
  const toolRegistry = await createRuntimeToolRegistry(
    { tools: agent.tools },
    {
      nodeId,
      reservedToolNames: [WORKFLOW_TOOL_NAME],
    },
  );

  const sandboxRegistry = createRuntimeSandboxRegistry({
    sandbox: agent.sandbox,
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
  const node: ResolvedAgentGraphBundle["root"] = {
    agent,
    channels: agent.channels,
    hookRegistry: createRuntimeHookRegistry(agent.hooks),
    nodeId,
    sandboxRegistry,
    sourceId: input.sourceId,
    subagentRegistry,
    toolRegistry,
    turnAgent: createResolvedRuntimeTurnAgent({
      agent,
      dynamicSubagentsAvailable: subagentRegistry.dynamicResolvers.length > 0,
      id: input.agentId,
      nodeId,
      tools: [...toolRegistry.preparedTools, ...subagentRegistry.preparedTools],
    }),
  };

  input.nodesByNodeId.set(nodeId, node);

  return node;
}

async function resolveRuntimeSubagents(input: {
  readonly childNodeIdsByParentNodeId: ReadonlyMap<string, readonly string[]>;
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
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
  const variant:
    | { readonly description: string; readonly dynamic?: never }
    | { readonly description?: never; readonly dynamic: ResolvedDynamicSubagentDefinition } =
    input.sourceRef.configResolver === undefined
      ? { description: input.sourceRef.description }
      : {
          dynamic: await resolveDynamicSubagentDefinition({
            definition: input.sourceRef.configResolver,
            moduleMap: input.moduleMap,
            nodeId: input.sourceRef.nodeId,
          }),
        };
  const resolvedSubagent: ResolvedRuntimeSubagentNode = {
    ...variant,
    kind: "subagent",
    logicalPath: input.sourceRef.logicalPath,
    name: input.sourceRef.name,
    nodeId: toRuntimeNodeId(input.sourceRef.nodeId),
    sourceId: input.sourceRef.sourceId,
    sourceKind: "module",
  };
  await resolveRuntimeAgentNode({
    agentId: input.sourceRef.name,
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
  const runtimeDefinition =
    input.sourceRef.workspaceMember === undefined
      ? resolvedRecord
      : await resolveWorkspaceRemoteTarget(resolvedRecord, input.sourceRef);

  const resolvedRemoteAgent: {
    auth?: ResolvedRuntimeRemoteAgentNode["auth"];
    description: string;
    forwardPrincipal?: boolean;
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
    url: await resolveRemoteAgentUrl({
      bakedUrl: input.sourceRef.url,
      logicalPath: input.sourceRef.logicalPath,
      resolvedUrl: runtimeDefinition.url,
    }),
  };

  if (typeof runtimeDefinition.auth === "function") {
    resolvedRemoteAgent.auth = runtimeDefinition.auth as ResolvedRuntimeRemoteAgentNode["auth"];
  }

  if (runtimeDefinition.forwardPrincipal === true) {
    resolvedRemoteAgent.forwardPrincipal = true;
  }

  const headers = resolveRemoteAgentHeaders(runtimeDefinition.headers);

  if (headers !== undefined) {
    resolvedRemoteAgent.headers = headers;
  }

  return resolvedRemoteAgent;
}

async function resolveWorkspaceRemoteTarget(
  definition: Record<string, unknown>,
  sourceRef: CompiledRemoteAgentNode,
): Promise<Record<string, unknown>> {
  if (typeof definition.resolveTarget !== "function" || sourceRef.workspaceMember === undefined) {
    throw new Error(
      `Workspace subagents source "${sourceRef.logicalPath}" is missing resolveTarget(member).`,
    );
  }
  const message = `Workspace subagents source "${sourceRef.logicalPath}" resolveTarget(member) must return an object with url and optional auth or headers.`;
  const target = expectObjectRecord(
    await (definition.resolveTarget as (member: unknown) => unknown)(sourceRef.workspaceMember),
    message,
  );
  expectOnlyKnownKeys(target, ["auth", "headers", "url"], message);
  return {
    ...target,
    forwardPrincipal: definition.forwardPrincipal,
  };
}

async function resolveRemoteAgentUrl(input: {
  readonly bakedUrl: string | undefined;
  readonly logicalPath: string;
  readonly resolvedUrl: unknown;
}): Promise<string> {
  if (typeof input.resolvedUrl === "function") {
    const resolved = await (input.resolvedUrl as () => unknown)();
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error(
        `Remote agent "${input.logicalPath}" url function must return a non-empty string.`,
      );
    }
    return resolved;
  }

  const url = input.bakedUrl ?? (typeof input.resolvedUrl === "string" ? input.resolvedUrl : "");
  if (url.length === 0) {
    throw new Error(`Remote agent "${input.logicalPath}" is missing a url.`);
  }
  return url;
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

function attachInheritedSandboxWorkspaceResources(input: {
  readonly manifest: CompiledAgentManifest;
  readonly nodesByNodeId: ReadonlyMap<string, ResolvedAgentGraphBundle["root"]>;
}): void {
  const parentNodeIdByChildNodeId = new Map(
    input.manifest.subagents.map((subagent) => [subagent.nodeId, subagent.parentNodeId]),
  );

  for (const [nodeId, node] of input.nodesByNodeId) {
    if (node.sandboxRegistry.sandbox.definition.inheritsParent !== true) continue;
    if (node.agent.dynamicSkillResolvers.length > 0) {
      throw new ResolveRuntimeAgentGraphError(
        `Sandbox "${node.sandboxRegistry.sandbox.definition.logicalPath}" selects parent.sandbox but agent node "${nodeId}" defines dynamic skills. Remove the child dynamic skills or give the child its own sandbox.`,
        { nodeId },
      );
    }

    const parentNodeId = parentNodeIdByChildNodeId.get(nodeId);
    if (parentNodeId === undefined) {
      throw new ResolveRuntimeAgentGraphError(
        `Sandbox "${node.sandboxRegistry.sandbox.definition.logicalPath}" selects parent.sandbox but agent node "${nodeId}" has no parent.`,
        { nodeId },
      );
    }
    const owner = resolveSandboxOwnerNode({
      nodeId: parentNodeId,
      nodesByNodeId: input.nodesByNodeId,
      parentNodeIdByChildNodeId,
    });
    (node.sandboxRegistry.sandbox as { inheritance?: unknown }).inheritance = {
      definition: owner.sandboxRegistry.sandbox.definition,
      nodeId: owner.nodeId,
      workspaceResourceRoot: owner.sandboxRegistry.sandbox.workspaceResourceRoot,
    };
    const workspacePrompt = createWorkspacePromptSection(owner.agent.workspaceSpec);
    if (workspacePrompt !== undefined) {
      (node.turnAgent as { instructions: readonly string[] }).instructions = [
        ...node.turnAgent.instructions,
        workspacePrompt,
      ];
    }
  }
}

function resolveSandboxOwnerNode(input: {
  readonly nodeId: string;
  readonly nodesByNodeId: ReadonlyMap<string, ResolvedAgentGraphBundle["root"]>;
  readonly parentNodeIdByChildNodeId: ReadonlyMap<string, string>;
}): ResolvedAgentGraphBundle["root"] {
  const node = input.nodesByNodeId.get(toRuntimeNodeId(input.nodeId));
  if (node === undefined) {
    throw new ResolveRuntimeAgentGraphError(`Missing parent runtime node "${input.nodeId}".`, {
      nodeId: input.nodeId,
    });
  }
  if (node.sandboxRegistry.sandbox.definition.inheritsParent !== true) return node;

  const parentNodeId = input.parentNodeIdByChildNodeId.get(input.nodeId);
  if (parentNodeId === undefined) {
    throw new ResolveRuntimeAgentGraphError(
      `Inherited sandbox node "${input.nodeId}" has no parent.`,
      {
        nodeId: input.nodeId,
      },
    );
  }
  return resolveSandboxOwnerNode({ ...input, nodeId: parentNodeId });
}

function createChildNodeIdsByParentNodeId(
  manifest: CompiledAgentManifest,
): ReadonlyMap<string, readonly string[]> {
  const childNodeIdsByParentNodeId = new Map<string, string[]>();

  for (const subagent of manifest.subagents) {
    const existing = childNodeIdsByParentNodeId.get(subagent.parentNodeId);

    if (existing === undefined) {
      childNodeIdsByParentNodeId.set(subagent.parentNodeId, [subagent.nodeId]);
      continue;
    }

    existing.push(subagent.nodeId);
  }

  return childNodeIdsByParentNodeId;
}

function toRuntimeNodeId(nodeId: string): string {
  return nodeId === ROOT_COMPILED_AGENT_NODE_ID ? ROOT_RUNTIME_AGENT_NODE_ID : nodeId;
}
