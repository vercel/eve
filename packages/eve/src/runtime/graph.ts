import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import type { ResolvedAgent, ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Stable node id used by the runtime-owned graph bundle for the root agent.
 */
export const ROOT_RUNTIME_AGENT_NODE_ID = "__root__";

/**
 * One resolved runtime-owned agent node in the recursive compiled graph.
 */
export interface ResolvedRuntimeAgentNode {
  readonly agent: ResolvedAgent;
  /**
   * The merged set of channels (framework defaults + authored overrides
   * minus authored disables) that the Nitro mounting loop should mount.
   * Computed by `resolve-agent-graph.ts` so the host plumbing never has to
   * combine framework defaults with the resolved-agent's authored channels.
   */
  readonly channels: readonly ResolvedChannelDefinition[];
  /**
   * Per-node hook registry. Stream-event subscribers fan out alongside
   * channel adapter event handlers.
   */
  readonly hookRegistry: RuntimeHookRegistry;
  readonly nodeId: string;
  readonly sandboxRegistry: RuntimeSandboxRegistry;
  readonly sourceId?: string;
  readonly subagentRegistry: RuntimeSubagentRegistry;
  readonly toolRegistry: RuntimeToolRegistry;
  readonly turnAgent: RuntimeTurnAgent;
}

/**
 * Recursive runtime-owned compiled graph bundle shared across root and child
 * subagent execution.
 */
export interface ResolvedAgentGraphBundle {
  readonly nodesByNodeId: ReadonlyMap<string, ResolvedRuntimeAgentNode>;
  readonly root: ResolvedRuntimeAgentNode;
}

/**
 * Resolves one runtime-owned agent node from the compiled recursive graph.
 */
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
