import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  reasoning: "medium",
  // Coding sessions run long; compact before the context gets crowded.
  compaction: { thresholdPercent: 0.7 },
});
