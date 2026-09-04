import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate cost-bounded research tasks.",
  limits: { maxTokenCostUsdPerSession: 1.5 },
  model: "anthropic/claude-sonnet-5",
});
