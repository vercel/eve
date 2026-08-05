import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "action.result"(event, ctx) {
      console.info("action result", {
        result: event.data.result,
        sessionId: ctx.session.id,
        status: event.data.status,
      });
    },
  },
});
