import { defineAgent } from "#public/index.js";

// Epoch 40 had no per-turn `limits.maxModelRequestsPerTurn` or `limits.turnTimeoutMs`;
// epoch 41 adds both as optional fields, which is additive.
export default defineAgent({
  description: "Investigate the request within the session's limits.",
  limits: { maxTokenCostUsdPerSession: 5 },
  model: "openai/gpt-5.6-sol",
});
