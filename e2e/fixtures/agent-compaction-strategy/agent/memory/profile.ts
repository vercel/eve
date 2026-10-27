import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "A fixed profile value recalled at the start of every turn.",
  provider: {
    recall: {
      async "turn.started"() {
        return { messages: [{ content: "PROFILE_VALUE=RECALLED", id: "profile" }] };
      },
    },
  },
  scope: byPrincipal,
});
