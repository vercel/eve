import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagentDepth: 4,
  },
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
