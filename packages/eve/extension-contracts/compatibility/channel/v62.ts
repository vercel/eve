// Epoch 62 of the channel capability: the authoring contract of epoch 61 still compiles.
// Epoch 63 adds an optional `windows` usage field to subagent results.
import { defineChannel } from "#public/channels/index.js";

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
