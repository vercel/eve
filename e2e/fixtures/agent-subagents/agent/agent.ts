import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagentDepth: 4,
    maxSubagents: 2,
  },
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
