import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRouter } from "#tools/provided/agent-router.js";
import { runAgentRouterTask } from "#execution/tools/agent-router.js";
import { decide } from "#ai/decide.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

vi.mock("#ai/decide.js", () => ({ decide: vi.fn() }));

describe("agentRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defines a task tool", () => {
    const definition = agentRouter();

    expect(definition.availableInSubagents).toBe(false);
    expect(definition.description).toContain("best available subagent");
    expect(definition.task).toBe(runAgentRouterTask);
  });

  it("routes through all workflow agent descriptions", async () => {
    vi.mocked(decide).mockResolvedValue({
      answers: { route: { choice: "operator", type: "choice" } },
    } as never);
    const { agent, send } = replyingAgent("operated");
    const abortSignal = new AbortController().signal;
    const ctx = workflowContext({
      abortSignal,
      agent,
      agents: {
        operator: { description: "Execute operational changes." },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(runAgentRouterTask({ message: "Deploy the service" }, ctx)).resolves.toBe(
      "operated",
    );
    expect(decide).toHaveBeenCalledWith({
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
    expect(agent).toHaveBeenCalledWith("operator");
    expect(send).toHaveBeenCalledWith("Deploy the service", { signal: abortSignal });
  });

  it("ignores agents without descriptions", async () => {
    const { agent, send } = replyingAgent("researched");
    const ctx = workflowContext({
      agent,
      agents: {
        agent: { description: "" },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(runAgentRouterTask({ message: "Investigate" }, ctx)).resolves.toBe("researched");
    expect(decide).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher");
    expect(send).toHaveBeenCalledWith("Investigate", { signal: expect.any(AbortSignal) });
  });

  it("invokes the only available described agent without decision", async () => {
    const { agent, send } = replyingAgent("researched");
    const ctx = workflowContext({
      agent,
      agents: { researcher: { description: "Investigate and explain." } },
    });

    await expect(runAgentRouterTask({ message: "Investigate" }, ctx)).resolves.toBe("researched");
    expect(decide).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher");
    expect(send).toHaveBeenCalledWith("Investigate", { signal: expect.any(AbortSignal) });
  });

  it("rejects an agent map without descriptions before decision", async () => {
    const ctx = workflowContext({
      agent: vi.fn(),
      agents: { agent: { description: "  " } },
    });

    await expect(runAgentRouterTask({ message: "Route me" }, ctx)).rejects.toThrow(
      "agentRouter requires at least one available agent with a description.",
    );
    expect(decide).not.toHaveBeenCalled();
  });
});

/** An agent whose session replies to every message with `message`. */
function replyingAgent(message: string) {
  const send = vi.fn(async () => ({
    result: async () => ({ data: undefined, message, status: "waiting" as const }),
  }));
  return { agent: vi.fn(() => ({ send })), send };
}

function workflowContext(
  input: Pick<WorkflowToolContext, "agent" | "agents"> &
    Partial<Pick<WorkflowToolContext, "abortSignal">>,
): WorkflowToolContext {
  return {
    abortSignal: input.abortSignal ?? new AbortController().signal,
    agent: input.agent,
    agents: input.agents,
  } as WorkflowToolContext;
}
