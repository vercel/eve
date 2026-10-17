import { defineAgent } from "#public/index.js";

// Epoch 37 `action.result` errors had no `name`; epoch 38 adds it as optional.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
});
