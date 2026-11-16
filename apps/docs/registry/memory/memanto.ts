import { memantoMemory } from "@moorcheh-ai/memanto/eve";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

const provider = memantoMemory({
  apiKey: process.env.MOORCHEH_API_KEY,
  baseUrl: process.env.MEMANTO_BASE_URL,
  capture: false,
});

export default defineMemory({
  description: "Recall and manage durable context for the current user.",
  provider: {
    ...provider,
    recall: { "turn.started": provider.recall["turn.started"] },
  },
  scope: byPrincipal,
});
