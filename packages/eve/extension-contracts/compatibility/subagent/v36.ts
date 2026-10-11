import { defineAgent } from "#public/index.js";

// Epoch 37 re-declares the reasoning level type to exclude the AI SDK's new `max`
// level, so a subagent that sets a reasoning level keeps compiling.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
