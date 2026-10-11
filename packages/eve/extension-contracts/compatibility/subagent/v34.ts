import { defineAgent } from "#public/index.js";

// Epoch 35 adds an optional `modelOptions.promptCache`. A subagent that sets
// only provider options keeps compiling.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
  modelOptions: { providerOptions: { gateway: { order: ["anthropic"] } } },
});
