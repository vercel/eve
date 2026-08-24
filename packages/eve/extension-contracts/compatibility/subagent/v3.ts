import { defineAgent } from "#public/index.js";

export default defineAgent({
  description: "Summarize long documents.",
  experimental: { tasks: true },
  model: "anthropic/claude-sonnet-5",
});
