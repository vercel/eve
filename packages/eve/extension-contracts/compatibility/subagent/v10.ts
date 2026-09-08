import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Complete a bounded research assignment.",
  model: "openai/gpt-5.5",
  reasoning: "low",
  limits: { maxTokenCostUsdPerSession: 1 },
});
