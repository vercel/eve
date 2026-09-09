import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "turn.started"(event, ctx) {
      console.info(event.meta.id, event.data.turnId, ctx.session.id);
    },
  },
});
