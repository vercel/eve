import { defineChannel } from "#public/channels/index.js";

// Epoch 41 `task.settled` events had no `cancel`; epoch 42 adds it as optional.
// Channels that read only `status` still see `"cancelled"`.
export default defineChannel({
  routes: [],
  events: {
    "task.settled"(event) {
      console.info("task settled", { name: event.name, status: event.status });
    },
  },
});
