import { defineHook } from "#public/hooks/index.js";

// Epoch 31 authorization events had no `principalId`; it is additive.
export default defineHook({
  events: {
    "authorization.required"(event, ctx) {
      console.info("sign-in required", {
        attemptId: event.data.attemptId,
        name: event.data.name,
        sessionId: ctx.session.id,
      });
    },
    "authorization.completed"(event) {
      console.info("sign-in completed", { name: event.data.name, outcome: event.data.outcome });
    },
  },
});
