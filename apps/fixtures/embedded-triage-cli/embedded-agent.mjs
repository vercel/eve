import { defineEmbeddedAgent } from "eve/embedded";
import { mockModel } from "eve/evals";

const triage = {
  category: "authentication",
  priority: "high",
  summary: "Customer cannot sign in after resetting their password.",
};

export default defineEmbeddedAgent({
  instructions:
    "Triage the supplied support ticket. Return its category, priority, and a concise summary.",
  model: mockModel(({ tools }) => {
    if (tools.some((tool) => tool.name === "final_output")) {
      return {
        toolCalls: [{ id: "triage-result", input: triage, name: "final_output" }],
      };
    }
    return "Preparing support ticket triage.";
  }),
  modelContextWindowTokens: 32_000,
  outputSchema: {
    additionalProperties: false,
    properties: {
      category: { enum: ["authentication", "billing", "bug", "other"], type: "string" },
      priority: { enum: ["low", "medium", "high", "urgent"], type: "string" },
      summary: { type: "string" },
    },
    required: ["category", "priority", "summary"],
    type: "object",
  },
});
