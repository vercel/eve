import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "step.started"(event, ctx) {
      console.info("model step started", {
        modelId: event.data.modelId,
        sessionId: ctx.session.id,
      });
    },
  },
});
