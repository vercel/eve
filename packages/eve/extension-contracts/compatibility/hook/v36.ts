// Existing message.received handlers remain valid when the event carries clientContext.
import { defineHook } from "#public/hooks/index.js";
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: event.data.message, path: "last-message.txt" });
    },
  },
});
