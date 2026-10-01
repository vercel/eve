import { defineChannel } from "#public/channels/index.js";

// Epoch 43 `turn.waiting` events had no `on`; epoch 44 adds it.
// Channels that read only `turnId` keep working.
export default defineChannel({
  routes: [],
  events: {
    "turn.waiting"(event) {
      console.info("turn waiting", { turnId: event.turnId });
    },
  },
});
