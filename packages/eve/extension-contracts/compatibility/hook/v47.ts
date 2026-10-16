import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "call.started"(event, ctx) {
      const clearance = event.data.clearedBy;
      if (clearance !== undefined && "interactionId" in clearance) {
        console.info(ctx.session.id, clearance.interactionId);
      }
    },
  },
});
