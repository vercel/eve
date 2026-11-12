import { claudeMem } from "claude-mem/eve";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Recall and save durable context for the current user.",
  provider: claudeMem({ apiKey: process.env.CLAUDE_MEM_API_KEY }),
  scope: byPrincipal,
});
