import { defineHook } from "eve/hooks";

/** A check the turn depends on: when it throws, the turn fails rather than run without it. */
export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      if (JSON.stringify(ctx.view.deliveries).includes("[policy: unavailable]")) {
        throw new Error("The policy service is unavailable.");
      }
      return null;
    },
  },
});
