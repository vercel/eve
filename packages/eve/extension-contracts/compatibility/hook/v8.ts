import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "subagent.completed"(event, ctx) {
      console.info("subagent completed", {
        output: event.data.output,
        sessionId: ctx.session.id,
        subagentName: event.data.subagentName,
      });
    },
  },
});
