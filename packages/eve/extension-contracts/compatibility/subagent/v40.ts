// Epoch 40 of the subagent capability: the authoring contract of epoch 39 still compiles.
// Epoch 41 adds an optional `windows` usage field to subagent results.
import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
});
