import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "session.started"(_event, ctx) {
      console.info("session started", {
        agentName: ctx.agent.name,
        sessionId: ctx.session.id,
      });
    },
  },
});
