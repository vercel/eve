import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Delegate research tasks.",
  model: "anthropic/claude-sonnet-5",
});
