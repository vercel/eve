import { defineHook } from "#public/hooks/index.js";

// Epoch 28 hook contexts add cancel(); hooks written before it keep working unchanged.
export default defineHook({
  events: {
    async "step.started"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({
        content: `${event.data.turnId}:${String(event.data.stepIndex)}`,
        path: "last-step.txt",
      });
    },
  },
});
