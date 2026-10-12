import { defineAgent } from "#public/index.js";

// Epoch 37 reached the v26 stream event types through client results; epoch 38 replaces
// them with v27 session events. Subagents that don't read session events keep working.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
