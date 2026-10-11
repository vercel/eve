import { defineHook } from "#public/hooks/index.js";

// Epoch 37 calls had no `cancelled` status, and sign-ins didn't name the calls they stopped;
// both are additive, so a hook that handles the earlier statuses still compiles.
export default defineHook({
  events: {
    "action.result"(event) {
      if (event.data.status === "failed") {
        console.info("call failed", { callId: event.data.result.callId });
      }
    },
    "authorization.required"(event, ctx) {
      console.info("sign-in required", { name: event.data.name, sessionId: ctx.session.id });
    },
  },
});
