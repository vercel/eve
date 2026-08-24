/** Stable node id used by compiled artifacts for the root authored agent. */
export const ROOT_COMPILED_AGENT_NODE_ID = "__root__";

/** Creates an injective child node id from one canonical parent and opaque source id. */
export function createCompiledSubagentNodeId(parentNodeId: string, sourceId: string): string {
  const segment = encodeCompiledAgentNodeIdSegment(sourceId);
  return parentNodeId === ROOT_COMPILED_AGENT_NODE_ID ? segment : `${parentNodeId}::${segment}`;
}

function encodeCompiledAgentNodeIdSegment(sourceId: string): string {
  const escaped = sourceId.replaceAll("%", "%25").replaceAll(":", "%3A");
  return escaped === ROOT_COMPILED_AGENT_NODE_ID ? "%5F%5Froot%5F%5F" : escaped;
}
