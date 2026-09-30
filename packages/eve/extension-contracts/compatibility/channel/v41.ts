import { defineChannel } from "#public/channels/index.js";

// Epoch 41 `turn.failed` events had no `terminal`; epoch 42 adds it as optional.
export default defineChannel({
  routes: [],
  events: {
    "turn.failed"(event) {
      console.info("turn failed", { code: event.code, message: event.message });
    },
    "session.failed"(event) {
      console.info("session failed", { code: event.code, sessionId: event.sessionId });
    },
  },
});
