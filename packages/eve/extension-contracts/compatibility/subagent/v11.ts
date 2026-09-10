import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate batched research tasks.",
  experimental: {
    workflow: { modelCallsPerStep: 2 },
  },
  model: "anthropic/claude-sonnet-5",
});
