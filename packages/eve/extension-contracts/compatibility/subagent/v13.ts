import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate persistent research tasks.",
  experimental: {
    workflow: {
      retention: 0,
    },
  },
  model: "anthropic/claude-sonnet-5",
});
