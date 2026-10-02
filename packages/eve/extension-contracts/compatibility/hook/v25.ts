import { defineHook } from "#public/hooks/index.js";

// Epoch 25 hook contexts also exposed getSkill(); hooks that never called it keep working.
export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: event.data.turnId, path: "last-turn.txt" });
    },
  },
});
