import { defineHook } from "eve/hooks";

/**
 * Notifies after each turn settles. A request marked `[notify: unavailable]` makes the
 * notification throw: the turn has already ended, so there's no turn to fail, and eve logs it.
 */
export default defineHook({
  events: {
    "turn.settled"(event, ctx) {
      if (!JSON.stringify(ctx.view.deliveries).includes("[notify: unavailable]")) return null;
      throw new Error(`The notification service is unavailable after ${event.data.turnId}.`);
    },
  },
});
