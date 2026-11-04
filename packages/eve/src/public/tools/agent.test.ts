import { describe, expect, it } from "vitest";

import { agent, agentWithModel } from "#public/tools/agent.js";
import { agentWithModelServeWorkflow } from "#runtime/subagents/workflow.js";
import { serializeInputSchema } from "#tools/schema.js";

describe("agentWithModel", () => {
  it("does not change the default agent tool input", () => {
    expect(serializeInputSchema(agent.inputSchema)).toMatchObject({
      properties: { message: { type: "string" } },
      required: ["message"],
    });
    expect(serializeInputSchema(agent.inputSchema)).not.toHaveProperty("properties.model");
  });

  it("defines a root-only serve tool with a required model input", () => {
    expect(agentWithModel.availableInSubagents).toBe(false);
    expect(agentWithModel.serve).toBe(agentWithModelServeWorkflow);
    expect(serializeInputSchema(agentWithModel.inputSchema)).toMatchObject({
      properties: {
        message: { type: "string" },
        model: { type: "string" },
      },
      required: ["message", "model"],
    });
  });
});
