import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "subagent.completed"(event, ctx) {
      console.info(event.data.subagentName, ctx.session.id);
    },
  },
});
