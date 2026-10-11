import { defineChannel } from "#public/channels/index.js";

// Epoch 59 `turn.failed` events had no `terminal`; epoch 60 adds it as optional.
// Handlers that read only the failure code and message keep working.
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
