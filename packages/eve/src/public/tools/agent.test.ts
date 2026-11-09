import { describe, expect, it } from "vitest";

import agentDefault, { agent } from "#public/tools/agent.js";
import { agentModelsServeWorkflow } from "#runtime/subagents/workflow.js";
import { readAgentToolModels } from "#tools/agent-models.js";
import { serializeInputSchema } from "#tools/schema.js";

const haiku = {
  doGenerate: async () => ({}),
  doStream: async () => ({}),
  modelId: "claude-haiku-5",
  provider: "anthropic.messages",
  specificationVersion: "v3",
} as const;

describe("agent", () => {
  it("is the default agent tool without models, so the model sees no model option", () => {
    expect(agent()).toBe(agentDefault);
    expect(agent({})).toBe(agentDefault);
    expect(serializeInputSchema(agentDefault.inputSchema)).toMatchObject({
      properties: { message: { type: "string" } },
      required: ["message"],
    });
    expect(serializeInputSchema(agentDefault.inputSchema)).not.toHaveProperty("properties.model");
  });

  it("offers the listed model keys, with their descriptions, as an optional model input", () => {
    const tool = agent({
      models: {
        "openai/gpt-6-sol": "Difficult reasoning",
        haiku: { model: haiku, description: "Cheap lookups", reasoning: "low" },
      },
    });

    expect(tool.serve).toBe(agentModelsServeWorkflow);
    const schema = serializeInputSchema(tool.inputSchema);
    expect(schema).toMatchObject({
      properties: {
        message: { type: "string" },
        model: { type: "string", enum: ["openai/gpt-6-sol", "haiku"] },
      },
      required: ["message"],
    });
    const description = (schema as { properties: { model: { description: string } } }).properties
      .model.description;
    expect(description).toContain('"openai/gpt-6-sol": Difficult reasoning');
    expect(description).toContain('"haiku": Cheap lookups');
  });

  it("never offers a configured tool to subagents", () => {
    const tool = agent({ models: { "openai/gpt-6-sol": "Difficult reasoning" } });

    expect(tool.availableInSubagents).toBe(false);
  });

  it("keeps each option's selection by key, live models included", () => {
    const tool = agent({
      models: {
        "openai/gpt-6-sol": "Difficult reasoning",
        haiku: { model: haiku, description: "Cheap lookups", reasoning: "low" },
        luna: { model: "openai/gpt-6-luna", description: "Routine tasks" },
      },
    });

    expect([...(readAgentToolModels(tool)?.entries() ?? [])]).toEqual([
      [
        "openai/gpt-6-sol",
        {
          description: "Difficult reasoning",
          key: "openai/gpt-6-sol",
          selection: "openai/gpt-6-sol",
        },
      ],
      [
        "haiku",
        {
          description: "Cheap lookups",
          key: "haiku",
          selection: { model: haiku, reasoning: "low" },
        },
      ],
      ["luna", { description: "Routine tasks", key: "luna", selection: "openai/gpt-6-luna" }],
    ]);
  });

  it("rejects empty and malformed models and unknown options", () => {
    expect(() => agent({ models: {} })).toThrow("at least one model");
    expect(() => agent({ models: { "openai/gpt-6-sol": "" } })).toThrow("agent({ models })");
    expect(() => agent({ models: { haiku: { model: haiku } as never } })).toThrow(
      "agent({ models })",
    );
    expect(() => agent({ models: { "openai/gpt-6-sol": "x" }, extra: true } as never)).toThrow(
      "agent options do not support extra.",
    );
  });
});
