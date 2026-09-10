import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate research with batched model calls.",
  model: "anthropic/claude-sonnet-5",
  experimental: { workflow: { modelCallsPerStep: 4 } },
  limits: { maxTokenCostUsdPerSession: 5 },
});
