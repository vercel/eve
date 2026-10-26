// Epoch 50 of the hook capability. Epoch 51 makes the provider runtime behind
// `SandboxEnvironment` opaque and drops its unused configuration hash; hooks that
// reach the sandbox through `ctx.getSandbox()` are unchanged, as this example shows.
import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.removePath({ force: true, path: ".eve/scratch", recursive: true });
    },
  },
});
