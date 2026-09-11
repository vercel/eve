import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate research tasks.",
  experimental: { workflow: { modelCallsPerStep: 4 } },
  model: "anthropic/claude-sonnet-5",
});
