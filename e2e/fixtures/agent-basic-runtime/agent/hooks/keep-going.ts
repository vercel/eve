import { deliveries } from "eve/events";
import { defineHook } from "eve/hooks";
import { KEEP_GOING_CONTINUATION, KEEP_GOING_MARKER } from "../lib/keep-going";

/** Continues a completed turn a person marked `[keep going]`, once: never its own continuation. */
export default defineHook({
  events: {
    "turn.settled"(event, ctx) {
      if (event.data.outcome !== "completed") return;
      const input = deliveries(ctx.view, { turnId: event.data.turnId });
      if (input.some(({ source }) => source !== undefined && "hook" in source)) return;
      if (!JSON.stringify(input).includes(KEEP_GOING_MARKER)) return;
      ctx.continue(KEEP_GOING_CONTINUATION);
    },
  },
});
