import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRouter } from "#tools/provided/agent-router.js";
import { executeAgentRouterTool, type AgentRouterInput } from "#execution/tools/agent-router.js";
import { evaluate } from "#ai/evaluate.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

vi.mock("#ai/evaluate.js", () => ({ evaluate: vi.fn() }));

describe("agentRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defines a workflow tool", () => {
    const definition = agentRouter();

    expect(definition.availableInSubagents).toBe(false);
    expect(definition.description).toContain("best available subagent");
    expect(definition.execute).toBe(executeAgentRouterTool);
  });

  it("routes through all workflow agent descriptions", async () => {
    vi.mocked(evaluate).mockResolvedValue({
      answers: { route: { choice: "operator", type: "choice" } },
    } as never);
    const agent = vi.fn().mockResolvedValue("operated");
    const abortSignal = new AbortController().signal;
    const ctx = workflowContext({
      message: "Deploy the service",
      abortSignal,
      agent,
      agents: {
        operator: { description: "Execute operational changes." },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(executeAgentRouterTool(ctx)).resolves.toBe("operated");
    expect(evaluate).toHaveBeenCalledWith({
      abortSignal,
      state: { message: "Deploy the service" },
      questions: {
        route: {
          criteria: {
            operator: "Execute operational changes.",
            researcher: "Investigate and explain.",
          },
          instructions: "Which subagent should handle this task?",
          type: "choice",
        },
      },
    });
    expect(agent).toHaveBeenCalledWith("operator", { message: "Deploy the service" });
  });

  it("ignores agents without descriptions", async () => {
    const agent = vi.fn().mockResolvedValue("researched");
    const ctx = workflowContext({
      message: "Investigate",
      agent,
      agents: {
        agent: { description: "" },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(executeAgentRouterTool(ctx)).resolves.toBe("researched");
    expect(evaluate).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher", { message: "Investigate" });
  });

  it("invokes the only available described agent without evaluation", async () => {
    const agent = vi.fn().mockResolvedValue("researched");
    const ctx = workflowContext({
      message: "Investigate",
      agent,
      agents: { researcher: { description: "Investigate and explain." } },
    });

    await expect(executeAgentRouterTool(ctx)).resolves.toBe("researched");
    expect(evaluate).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher", { message: "Investigate" });
  });

  it("rejects an agent map without descriptions before evaluation", async () => {
    const ctx = workflowContext({
      message: "Route me",
      agent: vi.fn(),
      agents: { agent: { description: "  " } },
    });

    await expect(executeAgentRouterTool(ctx)).rejects.toThrow(
      "agentRouter requires at least one available agent with a description.",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});

function workflowContext(
  input: Pick<WorkflowToolContext, "agent" | "agents"> & {
    readonly abortSignal?: AbortSignal;
    readonly message: string;
  },
): WorkflowToolContext<AgentRouterInput, JsonValue> {
  const call = {
    abortSignal: input.abortSignal ?? new AbortController().signal,
    callId: "call",
    input: { message: input.message },
  };
  return {
    agent: input.agent,
    agents: input.agents,
    receive: async () => call,
  } as never;
}
