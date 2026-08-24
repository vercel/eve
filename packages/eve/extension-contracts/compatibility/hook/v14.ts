import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "actions.requested"(event, ctx) {
      const toolCalls = event.data.actions.filter((action) => action.kind === "tool-call");
      console.info("actions requested", {
        sessionId: ctx.session.id,
        toolNames: toolCalls.map((action) => action.toolName),
        turnId: event.data.turnId,
      });
    },
  },
});
