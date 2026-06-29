import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagentDepth: 4,
  },
  model: "openai/gpt-5.5",
  reasoning: "high",
});
