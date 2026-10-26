// Epoch 68 of the channel capability. Epoch 69 makes the provider runtime behind
// `SandboxEnvironment` opaque and drops its unused configuration hash; channels that
// reach the sandbox through `ctx.getSandbox()` are unchanged, as this example shows.
import { defineChannel } from "#public/channels/index.js";

export default defineChannel({
  routes: [],
  events: {
    "turn.completed": async (_event, _channel, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeFiles({
        files: [{ content: new TextEncoder().encode("Sent to Alice."), path: "reports/sent.txt" }],
      });
    },
  },
});
