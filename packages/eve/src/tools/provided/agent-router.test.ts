import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRouter, auto } from "#tools/provided/agent-router.js";
import {
  AGENT_ROUTER_INPUT_SCHEMA,
  executeAgentRouterTool,
} from "#execution/tools/agent-router.js";
import { evaluate } from "#ai/evaluate.js";
import { serializeInputSchema } from "#tools/schema.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

vi.mock("#ai/evaluate.js", async (importOriginal) => ({
  ...(await importOriginal()),
  evaluate: vi.fn(),
}));

describe("agentRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defines a workflow tool", () => {
    const definition = agentRouter();

    expect(definition.availableInSubagents).toBe(false);
    expect(definition.description).toContain("best available subagent");
    expect(definition.execute).toBe(executeAgentRouterTool);
  });

  it("transports durable router options without exposing them to the model", async () => {
    vi.mocked(evaluate).mockResolvedValue({
      answers: { route: { choice: "operator", type: "choice" } },
    } as never);
    const definition = agentRouter({
      instructions: "Pick the best agent.",
      model: "custom/evaluator",
    });
    const schema = definition.inputSchema as typeof AGENT_ROUTER_INPUT_SCHEMA;

    const input = schema.parse({ message: "Deploy" });
    expect(input).toEqual({
      message: "Deploy",
      routerOptions: {
        instructions: "Pick the best agent.",
        model: "custom/evaluator",
      },
    });
    expect(serializeInputSchema(schema)).not.toHaveProperty("properties.routerOptions");

    await executeAgentRouterTool(
      input,
      workflowContext({
        agent: vi.fn().mockResolvedValue("operated"),
        agents: {
          operator: { description: "Execute changes." },
          researcher: { description: "Investigate." },
        },
      }),
    );
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "custom/evaluator",
        questions: {
          route: {
            criteria: { operator: "Execute changes.", researcher: "Investigate." },
            instructions: "Pick the best agent.",
            type: "choice",
          },
        },
      }),
    );
  });

  it.each([
    [null, "agentRouter options must be an object."],
    [{ model: "" }, "agentRouter model must be a non-empty model ID."],
    [{ instructions: " " }, "agentRouter instructions must be non-empty when provided."],
  ])("validates router options (%j)", (options, error) => {
    expect(() => agentRouter(options as never)).toThrow(error);
  });

  it("advertises arbitrary output schemas without propertyNames", () => {
    const serialized = serializeInputSchema(AGENT_ROUTER_INPUT_SCHEMA);

    expect(serialized).toMatchObject({
      properties: { outputSchema: { type: "object" } },
    });
    expect(JSON.stringify(serialized)).not.toContain('"propertyNames"');
    expect(() =>
      AGENT_ROUTER_INPUT_SCHEMA.parse({
        message: "Return a structured result",
        outputSchema: {
          $defs: { answer: { type: "string" } },
          properties: { answer: { $ref: "#/$defs/answer" } },
          type: "object",
        },
      }),
    ).not.toThrow();
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
      model: "typesafe-ai/jev",
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

  it("supports custom evaluator options", async () => {
    vi.mocked(evaluate).mockResolvedValue({
      answers: { route: { choice: "operator", type: "choice" } },
    } as never);
    const abortSignal = new AbortController().signal;

    await expect(
      auto({
        abortSignal,
        agents: {
          operator: " Execute operational changes. ",
          researcher: "Investigate and explain.",
        },
        instructions: "Pick the best agent.",
        message: "Deploy the service",
        model: "custom/evaluator",
      }),
    ).resolves.toBe("operator");
    expect(evaluate).toHaveBeenCalledWith({
      abortSignal,
      model: "custom/evaluator",
      state: { message: "Deploy the service" },
      questions: {
        route: {
          criteria: {
            operator: "Execute operational changes.",
            researcher: "Investigate and explain.",
          },
          instructions: "Pick the best agent.",
          type: "choice",
        },
      },
    });
  });

  it.each([
    {
      error: "agentRouter auto requires a non-empty message.",
      options: { agents: { researcher: "Research" }, message: "" },
    },
    {
      error: "agentRouter auto requires an agent description map.",
      options: { agents: null, message: "Research" },
    },
    {
      error: "agentRouter auto requires non-empty instructions when provided.",
      options: { agents: { researcher: "Research" }, instructions: " ", message: "Research" },
    },
    {
      error: "agentRouter auto requires a non-empty model ID when provided.",
      options: { agents: { researcher: "Research" }, message: "Research", model: "" },
    },
    {
      error: "agentRouter auto requires a non-empty model ID when provided.",
      options: { agents: { researcher: "Research" }, message: "Research", model: {} },
    },
    {
      error: 'agentRouter auto requires a string description for agent "researcher".',
      options: { agents: { researcher: 42 }, message: "Research" },
    },
  ])("validates helper input: $error", async ({ error, options }) => {
    await expect(auto(options as never)).rejects.toThrow(error);
    expect(evaluate).not.toHaveBeenCalled();
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
