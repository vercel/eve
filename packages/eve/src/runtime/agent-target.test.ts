import { describe, expect, it } from "vitest";

import type { ResolvedAgentGraphBundle, ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { AgentTargetError, resolveAgentTarget } from "#runtime/agent-target.js";

describe("resolveAgentTarget", () => {
  it("walks nested static local descendants and normalizes outer whitespace", () => {
    const critic = createNode("critic");
    const researcher = createNode("researcher", [["critic", staticLocal("critic", critic.nodeId)]]);
    const root = createNode("__root__", [
      ["researcher", staticLocal("researcher", researcher.nodeId)],
    ]);
    const graph = createGraph(root, researcher, critic);

    expect(resolveAgentTarget(graph, "  researcher/critic  ")).toEqual({
      nodeId: "critic",
      path: "researcher/critic",
    });
  });

  it.each([
    ["", "invalid_agent_path", 400],
    ["/researcher", "invalid_agent_path", 400],
    ["researcher//critic", "invalid_agent_path", 400],
    ["researcher/../critic", "invalid_agent_path", 400],
    ["missing", "agent_not_found", 404],
  ] as const)("rejects %j with a stable typed error", (path, code, status) => {
    const graph = createGraph(createNode("__root__"));

    expect(() => resolveAgentTarget(graph, path)).toThrowError(
      expect.objectContaining({ code, status }) as AgentTargetError,
    );
  });

  it("rejects remote and dynamic descendants explicitly", () => {
    const root = createNode("__root__", [["remote", remote("remote")]], ["dynamic"]);
    const graph = createGraph(root);

    for (const path of ["remote", "dynamic"]) {
      expect(() => resolveAgentTarget(graph, path)).toThrowError(
        expect.objectContaining({
          code: "agent_not_directly_invocable",
          status: 400,
        }) as AgentTargetError,
      );
    }
  });
});

function createGraph(...nodes: ResolvedRuntimeAgentNode[]): ResolvedAgentGraphBundle {
  const root = nodes[0]!;
  return { nodesByNodeId: new Map(nodes.map((node) => [node.nodeId, node])), root };
}

function createNode(
  nodeId: string,
  entries: readonly (readonly [string, unknown])[] = [],
  dynamicNames: readonly string[] = [],
): ResolvedRuntimeAgentNode {
  return {
    nodeId,
    subagentRegistry: {
      dynamicResolvers: dynamicNames.map((name) => ({ name })),
      subagentsByName: new Map(entries),
    },
  } as never;
}

function staticLocal(name: string, nodeId: string) {
  return { definition: { description: name, kind: "subagent", name, nodeId } };
}

function remote(name: string) {
  return { definition: { description: name, kind: "remote", name, nodeId: name } };
}
