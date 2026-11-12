import { claudeMem } from "claude-mem/eve";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

const provider = claudeMem({ apiKey: process.env.CLAUDE_MEM_API_KEY });

export default defineMemory({
  description: "Recall and save durable context for the current user.",
  provider: {
    ...provider,
    // get_observations fetches by ID across every project the key can see, so it
    // would let one principal read another's memory through the shared key.
    async tools(context) {
      const { get_observations: _unscoped, ...tools } = (await provider.tools?.(context)) ?? {};
      return tools;
    },
  },
  scope: byPrincipal,
});
