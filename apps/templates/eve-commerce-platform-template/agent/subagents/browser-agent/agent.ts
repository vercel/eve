import { defineAgent } from "eve";

export default defineAgent({
  tool: false,
  description:
    "Execute one bounded browser assignment for the shopping coordinator, including checkout preparation, optional durable browser images, human-takeover handoff for sign-in or payment entry, cleanup, and a concise verified result.",
  model: "meta/muse-spark-1.3",
  reasoning: "low",
  compaction: { threshold: 0.7 },
});
