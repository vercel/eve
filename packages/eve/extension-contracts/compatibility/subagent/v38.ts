import { defineAgent } from "#public/index.js";

// Epoch 39 moves dynamic values and hooks to select, record, render, and run. Subagents
// that don't define dynamic values keep working.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
