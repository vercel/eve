import { describe, expect, it } from "vitest";

import { createResolvedRuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { ResolvedAgent } from "#runtime/types.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";

const APPLICATION_OWNER = { kind: "application" } as const;

function createFrameworkAgentTool(): PreparedRuntimeTool {
  return {
    behavior: {
      availability: ["root-session"],
      handling: {
        kind: "dispatch",
        target: {
          kind: "self-agent-call",
          nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
          subagentName: AGENT_TOOL_NAME,
        },
      },
    },
    description: "Message a persistent agent.",
    inputSchema: null,
    kind: "authored-tool",
    logicalPath: `tools/${AGENT_TOOL_NAME}.ts`,
    name: AGENT_TOOL_NAME,
    owner: { feature: "agent-messaging", kind: "framework" },
    sourceId: `framework:tools/${AGENT_TOOL_NAME}.ts`,
  };
}

function createResolvedAgentForTest(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  const agent: Partial<ResolvedAgent> = {
    config: { name: "test-agent" } as ResolvedAgent["config"],
    connections: [],
    instructions: [],
    skills: [],
    workspaceSpec: { rootEntries: [] },
    ...overrides,
  };
  return agent as ResolvedAgent;
}

describe("createResolvedRuntimeTurnAgent", () => {
  it("partitions static user instructions into initial messages", () => {
    const turnAgent = createResolvedRuntimeTurnAgent({
      agent: createResolvedAgentForTest({
        instructions: [
          {
            content: "System policy.",
            logicalPath: "instructions/system.ts",
            name: "instructions/system",
            owner: APPLICATION_OWNER,
            role: "system",
            sourceId: "instructions/system.ts",
            sourceKind: "module",
          },
          {
            content: "  Pinned user context.  ",
            logicalPath: "instructions/user.ts",
            name: "instructions/user",
            owner: APPLICATION_OWNER,
            role: "user",
            sourceId: "instructions/user.ts",
            sourceKind: "module",
          },
          {
            content: " \n ",
            logicalPath: "instructions/empty.ts",
            name: "instructions/empty",
            owner: APPLICATION_OWNER,
            role: "user",
            sourceId: "instructions/empty.ts",
            sourceKind: "module",
          },
        ],
      }),
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      tools: [createFrameworkAgentTool()],
    });

    expect(turnAgent.initialMessages).toEqual([
      { content: "Pinned user context.", kind: "context.instruction", role: "user" },
    ]);
    expect(turnAgent.instructions).toContainEqual(
      "Instructions (instructions/system)\nSystem policy.",
    );
  });
});
