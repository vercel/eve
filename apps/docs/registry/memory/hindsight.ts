import { hindsightMemory } from "@vectorize-io/hindsight-eve";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

const provider = hindsightMemory();

export default defineMemory({
  description: "Long-term memory about the current user.",
  provider: {
    ...provider,
    // Recall stays outside conversation history; compaction no longer needs another recall.
    recall: { "turn.started": provider.recall["turn.started"] },
  },
  scope: byPrincipal,
});
