import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";

export { AGENT_TOOL_DESCRIPTION } from "#public/tools/agent.js";

/**
 * Stable model-visible name for the root-only agent delegation tool.
 */
export const AGENT_TOOL_NAME = "agent";

/**
 * Whether one node's sessions receive the framework `agent` delegation
 * tool.
 *
 * Single source of truth for the injection predicate: node-step uses it to
 * decide whether to supply the delegation behavior, and prompt bootstrap
 * uses it to decide whether agent-messaging instructions may reference the
 * tool. The capability prepares only when the canonical `tools/agent.ts`
 * slot survived composition with framework ownership — an authored
 * replacement is an ordinary tool, and a disabled slot compiles no row.
 */
export function isImplicitAgentToolAvailable(input: {
  /** Undefined when the caller prepares a turn without a graph node (never root). */
  readonly nodeId: string | undefined;
  readonly tools: readonly {
    readonly name: string;
    readonly owner?: { readonly kind: string };
  }[];
}): boolean {
  return (
    input.nodeId === ROOT_RUNTIME_AGENT_NODE_ID &&
    input.tools.some((tool) => tool.name === AGENT_TOOL_NAME && tool.owner?.kind === "framework")
  );
}
