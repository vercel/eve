import { defineChannel } from "#public/channels/index.js";

// Epoch 60 `action.result` errors had no `name`; epoch 61 adds it as optional.
// Channels that read the failure code and message keep working.
export default defineChannel({
  routes: [],
  events: {
    "action.result"(event) {
      if (event.error === undefined) return;
      console.info("action failed", { code: event.error.code, message: event.error.message });
    },
  },
});
