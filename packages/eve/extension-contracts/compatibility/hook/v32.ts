import { defineHook } from "#public/hooks/index.js";

// Epoch 32 stream events had no `meta.index`. Hooks observe events as they are
// written, so they still receive none; it is optional and additive.
export default defineHook({
  events: {
    "*"(event, ctx) {
      console.info("event", { id: event.meta.id, sessionId: ctx.session.id, type: event.type });
    },
  },
});
