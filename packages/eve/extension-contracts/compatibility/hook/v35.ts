import { defineHook } from "#public/hooks/index.js";

// Epoch 35 `turn.waiting` events had no `on`; epoch 36 adds it.
// Hooks that read only `turnId` keep working.
export default defineHook({
  events: {
    "turn.waiting"(event, ctx) {
      console.info("turn waiting", { sessionId: ctx.session.id, turnId: event.data.turnId });
    },
  },
});
