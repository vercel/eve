import type { ResolvedAgentGraphBundle } from "#runtime/graph.js";

export type AgentTargetErrorCode =
  | "invalid_agent_path"
  | "agent_not_found"
  | "agent_not_directly_invocable";

/** Error raised when a public agent selector cannot resolve to a static local descendant. */
export class AgentTargetError extends Error {
  readonly code: AgentTargetErrorCode;
  readonly status: 400 | 404;

  constructor(code: AgentTargetErrorCode, message: string) {
    super(message);
    this.name = "AgentTargetError";
    this.code = code;
    this.status = code === "agent_not_found" ? 404 : 400;
  }
}

/** Validated public selector and its runtime-only compiled node id. */
export interface ResolvedAgentTarget {
  readonly nodeId: string;
  readonly path: string;
}

export type AgentTargetResolver = (agent: string) => ResolvedAgentTarget;

/** Resolves one root-relative public path through the static local runtime graph. */
export function resolveAgentTarget(
  graph: ResolvedAgentGraphBundle,
  requestedPath: string,
): ResolvedAgentTarget {
  const path = normalizeAgentTargetPath(requestedPath);
  const segments = path.split("/");
  let node = graph.root;
  const resolvedSegments: string[] = [];

  for (const segment of segments) {
    resolvedSegments.push(segment);
    const resolvedPath = resolvedSegments.join("/");
    const registered = node.subagentRegistry.subagentsByName.get(segment);
    if (registered === undefined) {
      if (node.subagentRegistry.dynamicResolvers.some((resolver) => resolver.name === segment)) {
        throw new AgentTargetError(
          "agent_not_directly_invocable",
          `Agent "${resolvedPath}" is dynamic. Direct invocation only supports an entirely static local path.`,
        );
      }
      throw new AgentTargetError(
        "agent_not_found",
        `Agent "${resolvedPath}" was not found. Only statically declared local descendants can be invoked directly.`,
      );
    }

    const definition = registered.definition;
    if (definition.kind === "remote") {
      throw new AgentTargetError(
        "agent_not_directly_invocable",
        `Agent "${resolvedPath}" is remote. Direct invocation only supports statically declared local descendants.`,
      );
    }
    if (definition.dynamic !== undefined) {
      throw new AgentTargetError(
        "agent_not_directly_invocable",
        `Agent "${resolvedPath}" is dynamic. Direct invocation only supports an entirely static local path.`,
      );
    }

    const child = graph.nodesByNodeId.get(definition.nodeId);
    if (child === undefined) {
      throw new AgentTargetError(
        "agent_not_found",
        `Agent "${resolvedPath}" is not available in the compiled runtime graph.`,
      );
    }
    node = child;
  }

  return { nodeId: node.nodeId, path };
}

function normalizeAgentTargetPath(requestedPath: string): string {
  const path = requestedPath.trim();
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment !== segment.trim(),
    )
  ) {
    throw new AgentTargetError(
      "invalid_agent_path",
      'Invalid agent path. Use a root-relative "/"-separated path such as "researcher/critic".',
    );
  }
  return path;
}
