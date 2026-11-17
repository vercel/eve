import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import type { ResolvedAgent, ResolvedChannelDefinition } from "#runtime/types.js";

export const ROOT_RUNTIME_AGENT_NODE_ID = "__root__";

export interface ResolvedRuntimeAgentNode {
  readonly agent: ResolvedAgent;
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly nodeId: string;
  readonly sandboxRegistry: RuntimeSandboxRegistry;
  readonly sourceId?: string;
  readonly subagentRegistry: RuntimeSubagentRegistry;
  readonly toolRegistry: RuntimeToolRegistry;
  readonly turnAgent: RuntimeTurnAgent;
}

export interface ResolvedAgentGraphBundle {
  readonly nodesByNodeId: ReadonlyMap<string, ResolvedRuntimeAgentNode>;
  readonly root: ResolvedRuntimeAgentNode;
}

export function getResolvedRuntimeAgentNode(
  bundle: ResolvedAgentGraphBundle,
  nodeId: string | undefined,
): ResolvedRuntimeAgentNode {
  if (nodeId === undefined || nodeId === ROOT_RUNTIME_AGENT_NODE_ID) {
    return bundle.root;
  }

  const node = bundle.nodesByNodeId.get(nodeId);

  if (node === undefined) {
    throw new Error(`Missing runtime agent node for node id "${nodeId}".`);
  }

  return node;
}
