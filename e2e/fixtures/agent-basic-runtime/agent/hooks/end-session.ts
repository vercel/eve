import { deliveries } from "eve/events";
import { defineHook } from "eve/hooks";

const END_SESSION_MARKER = "[end session]";

/** Retires a session once a turn carrying `[end session]` completes. */
export default defineHook({
  events: {
    "turn.settled"(event, ctx) {
      if (event.data.outcome !== "completed") return;
      const input = deliveries(ctx.view, { turnId: event.data.turnId });
      if (!JSON.stringify(input).includes(END_SESSION_MARKER)) return;
      ctx.end("Job completed.");
    },
  },
});
