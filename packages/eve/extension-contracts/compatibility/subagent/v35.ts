import { defineAgent } from "#public/index.js";

// Epoch 35 `turn.failed` events had no `terminal`; epoch 36 adds it as optional.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
});
