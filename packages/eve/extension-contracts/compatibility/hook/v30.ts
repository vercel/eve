import { defineHook } from "#public/hooks/index.js";

// Epoch 30 approval.settled carried no taskId; epoch 31 adds an optional taskId
// for approvals proxied from a child task, so existing handlers keep working.
export default defineHook({
  events: {
    async "approval.settled"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({
        content: `${event.data.requestId} ${event.data.outcome} by ${event.data.responderPrincipalId}`,
        path: "last-approval.txt",
      });
    },
  },
});
