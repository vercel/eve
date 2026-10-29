import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      try {
        await fetch("https://metrics.example.com/turns", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.METRICS_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            outcome: event.data.outcome,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        console.warn("metrics report failed", error);
      }
      const sandbox = await ctx.getSandbox();
      await sandbox.stop();
    },
  },
});
