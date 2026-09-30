import { defineChannel } from "#public/channels/index.js";

// Epoch 36 authorization events had no `principalId`; it is additive.
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
