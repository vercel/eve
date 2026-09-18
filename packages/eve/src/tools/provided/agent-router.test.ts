import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRouter } from "#tools/provided/agent-router.js";
import { executeAgentRouterTool } from "#execution/tools/agent-router.js";
import { evaluate } from "#ai/evaluate.js";
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
      abortSignal,
      agent,
      agents: {
        operator: { description: "Execute operational changes." },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(executeAgentRouterTool({ message: "Deploy the service" }, ctx)).resolves.toBe(
      "operated",
    );
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
      agent,
      agents: {
        agent: { description: "" },
        researcher: { description: "Investigate and explain." },
      },
    });

    await expect(executeAgentRouterTool({ message: "Investigate" }, ctx)).resolves.toBe(
      "researched",
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher", { message: "Investigate" });
  });

  it("invokes the only available described agent without evaluation", async () => {
    const agent = vi.fn().mockResolvedValue("researched");
    const ctx = workflowContext({
      agent,
      agents: { researcher: { description: "Investigate and explain." } },
    });

    await expect(executeAgentRouterTool({ message: "Investigate" }, ctx)).resolves.toBe(
      "researched",
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith("researcher", { message: "Investigate" });
  });

  it("forwards an output schema to the selected agent", async () => {
    vi.mocked(evaluate).mockResolvedValue({
      answers: { route: { choice: "researcher", type: "choice" } },
    } as never);
    const agent = vi.fn().mockResolvedValue({ answer: "done" });
    const ctx = workflowContext({
      agent,
      agents: { researcher: { description: "Investigate and explain." } },
    });
    const outputSchema = {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;

    await executeAgentRouterTool({ message: "Investigate", outputSchema }, ctx);

    expect(agent).toHaveBeenCalledWith("researcher", {
      message: "Investigate",
      outputSchema,
    });
  });

  it("rejects an agent map without descriptions before evaluation", async () => {
    const ctx = workflowContext({
      agent: vi.fn(),
      agents: { agent: { description: "  " } },
    });

    await expect(executeAgentRouterTool({ message: "Route me" }, ctx)).rejects.toThrow(
      "agentRouter requires at least one available agent with a description.",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});

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
