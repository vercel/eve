// Epoch 49 of the hook capability: sandbox sessions typed from the AI SDK. Epoch 50 declares
// eve-owned session types with the same methods and adds `writeFiles`, which is additive.
import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: ctx.session.id, path: ".eve/last-turn" });
    },
  },
});
