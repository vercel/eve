import { defineHook } from "#public/hooks/index.js";

// Epoch 35 `session.waiting`, `session.failed`, and `session.completed` events had no `usage`; epoch 36 adds it as optional.
// Hooks that read only the continuation token see no change.
export default defineHook({
  events: {
    "session.waiting"(event, ctx) {
      console.info("session waiting", {
        continuationToken: event.data.continuationToken,
        sessionId: ctx.session.id,
      });
    },
  },
});
