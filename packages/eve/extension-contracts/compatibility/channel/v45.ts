import { defineChannel } from "#public/channels/index.js";

// Epoch 45 sign-ins didn't name the calls they stopped, and calls had no `cancelled` status;
// both are additive.
export default defineChannel({
  routes: [],
  events: {
    "authorization.required"(event) {
      console.info("sign-in required", { name: event.name, url: event.authorization?.url });
    },
    "authorization.completed"(event) {
      console.info("sign-in completed", { name: event.name, outcome: event.outcome });
    },
  },
});
