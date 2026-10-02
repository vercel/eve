import { defineChannel } from "#public/channels/index.js";

// Epoch 43 `session.waiting`, `session.failed`, `session.completed`, and `turn.waiting` events had no `usage`; epoch 44 adds it as optional.
// Channels that read only the continuation token see no change.
export default defineChannel({
  routes: [],
  events: {
    "session.waiting"(event) {
      console.info("session waiting", { continuationToken: event.continuationToken });
    },
  },
});
