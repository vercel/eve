import { defineAgent } from "#public/index.js";

export default defineAgent({
  compaction: { thresholdPercent: 0.8 },
  description: "Delegate research tasks.",
  model: "anthropic/claude-sonnet-5",
});
