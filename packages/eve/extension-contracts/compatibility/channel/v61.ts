// Epoch 61 had no `decline` on input responses or `declined` input outcome; epoch 62 adds
// them as optional. Authoring code that never uses them keeps working.
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
