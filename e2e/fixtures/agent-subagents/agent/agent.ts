import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagentDepth: 4,
  },
  model: process.env.EVE_EVAL_MODEL ?? "anthropic/claude-sonnet-5",
  reasoning: "high",
});
