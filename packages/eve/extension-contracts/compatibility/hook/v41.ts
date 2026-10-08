import { defineHook } from "#public/hooks/index.js";

// Epoch 41 had no `history` option or `history.imported` event; epoch 42 adds both, which is additive.
export default defineHook({
  events: {
    "authorization.required": (event, ctx) => {
      console.info("Sign-in required", { name: event.data.name, sessionId: ctx.session.id });
    },
  },
});
