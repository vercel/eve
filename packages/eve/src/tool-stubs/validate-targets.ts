import type { ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { ToolStub } from "#tool-stubs/types.js";

export class InvalidToolStubTargetError extends Error {}

/** Check compiled tools without running dynamic resolvers or contacting connections. */
export function validateToolStubTargets(
  rules: readonly ToolStub[],
  graph: ResolvedAgentGraphBundle,
): void {
  for (const rule of rules) {
    if (!hasToolPath(graph, rule.tool.split("/"))) {
      throw new InvalidToolStubTargetError(
        `Tool stub "${rule.id}" names an unknown or unsupported tool path "${rule.tool}".`,
      );
    }
  }
}

function hasToolPath(graph: ResolvedAgentGraphBundle, path: readonly string[]): boolean {
  if (path.some((part) => part.length === 0)) return false;
  let node = graph.root;
  for (const [index, name] of path.entries()) {
    const tool = node.turnAgent.tools.find((tool) => tool.name === name);
    if (index === path.length - 1) {
      if (tool !== undefined) return tool.behavior?.handling?.kind !== "provider-tool";
      return (
        node.agent.dynamicToolResolvers.some(
          (resolver) =>
            resolver.extensionNamespace === undefined ||
            name.startsWith(`${resolver.extensionNamespace}__`),
        ) ||
        node.subagentRegistry.dynamicResolvers.some((resolver) => resolver.name === name) ||
        (name.includes("__") &&
          ((node.agent.dynamicConnectionResolvers?.length ?? 0) > 0 ||
            node.agent.connections.some((connection) =>
              name.startsWith(`${connection.connectionName}__`),
            )))
      );
    }
    if (tool === undefined)
      return node.subagentRegistry.dynamicResolvers.some((resolver) => resolver.name === name);
    const handling = tool.behavior?.handling;
    if (
      handling?.kind !== "dispatch" ||
      (handling.target.kind !== "subagent-call" && handling.target.kind !== "self-agent-call")
    )
      return false;
    node = graph.nodesByNodeId.get(handling.target.nodeId)!;
  }
  return false;
}
