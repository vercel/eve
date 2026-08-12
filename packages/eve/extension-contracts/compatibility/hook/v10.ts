import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const sandbox = await ctx.getSandbox();
      console.info("turn started", {
        networkPolicy: sandbox.getNetworkPolicy(),
        sessionId: ctx.session.id,
      });
    },
  },
});
