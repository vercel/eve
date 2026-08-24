import { describe, expect, it } from "vitest";

import { createResolvedRuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { AGENT_TOOL_NAME } from "#kernel/agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { ResolvedAgent } from "#runtime/types.js";

function createResolvedAgentForTest(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  const agent: Partial<ResolvedAgent> = {
    config: { name: "test-agent" } as ResolvedAgent["config"],
    connections: [],
    kernelPlan: { prepared: ["agent", "ask_question"] },
    instructions: [],
    skills: [],
    ...overrides,
  };
  return agent as ResolvedAgent;
}

describe("createResolvedRuntimeTurnAgent agent-messaging gating", () => {
  it("partitions static user instructions into initial messages", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        instructions: [
          {
            content: "System policy.",
            logicalPath: "instructions/system.ts",
            name: "instructions/system",
            owner: { kind: "application" },
            role: "system",
            sourceId: "instructions/system.ts",
            sourceKind: "module",
          },
          {
            content: "  Pinned user context.  ",
            logicalPath: "instructions/user.ts",
            name: "instructions/user",
            owner: { kind: "application" },
            role: "user",
            sourceId: "instructions/user.ts",
            sourceKind: "module",
          },
          {
            content: " \n ",
            logicalPath: "instructions/empty.ts",
            name: "instructions/empty",
            owner: { kind: "application" },
            role: "user",
            sourceId: "instructions/empty.ts",
            sourceKind: "module",
          },
        ],
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.initialMessages).toEqual([{ content: "Pinned user context.", role: "user" }]);
    expect(turnAgent.instructions).toContainEqual(
      "Instructions (instructions/system)\nSystem policy.",
    );
  });

  it("defers native agent messaging until session availability is known", () => {
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

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Tool execution"));
  });

  it("omits the messaging instruction for a root agent without the experimental opt-in", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest(),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });

  it("defers native task agent messaging until session availability is known", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { tasks: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("availability=busy"));
    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("taskId"));
  });

  it("omits the messaging instruction when an authored tool replaces the native agent capability", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
        kernelPlan: { prepared: [] },
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [
        {
          description: "Authored replacement for the native agent capability.",
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

  it("omits the messaging instruction when the compiled plan omits agent", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        config: {
          experimental: { subagentPersistentSessions: true },
          name: "test-agent",
        } as ResolvedAgent["config"],
        kernelPlan: { prepared: [] },
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
        kernelPlan: { prepared: [] },
      }),
      nodeId: "subagents/researcher",
      tools: [],
    });

    expect(turnAgent.instructions).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
  });
});
