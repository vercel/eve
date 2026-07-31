import { describe, expect, it } from "vitest";

import { createResolvedRuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { AGENT_TOOL_NAME } from "#runtime/framework-tools/agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { ResolvedAgent } from "#runtime/types.js";

function createResolvedAgentForTest(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  const agent: Partial<ResolvedAgent> = {
    config: { name: "test-agent" } as ResolvedAgent["config"],
    connections: [],
    disabledFrameworkTools: [],
    instructions: { markdown: "" } as ResolvedAgent["instructions"],
    skills: [],
    ...overrides,
  };
  return agent as ResolvedAgent;
}

describe("createResolvedRuntimeTurnAgent agent-messaging gating", () => {
  it("includes the messaging instruction for an opted-in root agent (framework agent tool)", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.instructions).toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(turnAgent.instructions).toContainEqual(expect.stringContaining("Tool execution"));
  });

  it("omits the messaging instruction for a root agent without the experimental opt-in", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest(),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });

  it("omits the messaging instruction when an authored tool named agent shadows the framework tool", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [
        {
          description: "Authored replacement for the framework agent tool.",
          inputSchema: null,
          kind: "authored-tool",
          logicalPath: `tools/${AGENT_TOOL_NAME}.ts`,
          name: AGENT_TOOL_NAME,
          sourceId: `tools/${AGENT_TOOL_NAME}.ts`,
        },
      ],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });

  it("omits the messaging instruction when the root disables the framework agent tool", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
        disabledFrameworkTools: [AGENT_TOOL_NAME],
      } as Partial<ResolvedAgent>),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });

  it("omits the messaging instruction for a non-root node without declared subagents", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
      }),
      nodeId: "subagents/researcher",
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });
});
