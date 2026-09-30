import { defineChannel } from "#public/channels/index.js";

// Epoch 37 stream events had no `meta.index`. Channel handlers observe events
// as they are written, so they still receive none; it is optional and additive.
export default defineChannel({
  routes: [],
  events: {
    "message.completed"(event) {
      console.info("reply ready", { turnId: event.turnId });
    },
  },
});
