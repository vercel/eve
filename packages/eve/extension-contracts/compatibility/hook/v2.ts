import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "turn.started"(event) {
      console.info(event.data.turnId, event.data.sequence);
    },
  },
});
