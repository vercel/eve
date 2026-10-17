import { defineAgent } from "#public/index.js";

// Epoch 38 agents never set `codeMode`; epoch 39 adds it as an optional, off-by-default flag.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
});
