import { defineAgent } from "#public/index.js";

/** Epoch 12 added workflow retention to authored subagent definitions. */
export default defineAgent({
  description: "Delegate ephemeral research tasks.",
  experimental: {
    workflow: {
      retention: 0,
    },
  },
  model: "anthropic/claude-sonnet-5",
});
