// Existing callbacks remain valid when the runtime supplies session.context.
import { defineHook } from "#public/hooks/index.js";
export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: event.data.turnId, path: "last-turn.txt" });
    },
  },
});
