import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "subagent.called"(event, ctx) {
      console.info("subagent called", {
        childSessionId: event.data.childSessionId,
        sessionId: ctx.session.id,
        subagentName: event.data.name,
      });
    },
  },
});
