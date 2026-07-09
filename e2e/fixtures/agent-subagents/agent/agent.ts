import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagents: 2,
  },
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
