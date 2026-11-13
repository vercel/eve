import { defineAgent, defineDynamic } from "eve";
import { resolveModeValue } from "@agent/lib/mode";

export default defineDynamic((context) => {
  const worker = defineAgent({
    tool: false,
    description:
      "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, optional durable browser images, human-takeover handoff, cleanup, and a concise verified result.",
    model: "meta/muse-spark-1.3",
    reasoning: "low",
    compaction: {
      threshold: 0.7,
    },
  });
  return resolveModeValue(context, {
    interactive: worker,
    "scheduled-worker": worker,
  });
});
