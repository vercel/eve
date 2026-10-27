import { defineHook } from "eve/hooks";

/** Asks for a compaction once the last model call's input passes 20,000 tokens. */
export default defineHook({
  events: {
    "model.requested"(_event, ctx) {
      if ((ctx.view.context.inputTokens ?? 0) > 20_000) ctx.compact();
    },
  },
});
