import { defineChannel } from "#public/channels/index.js";

// Epoch 40 `task.settled` events had no `name` or `kind`; epoch 41 adds both as optional.
export default defineChannel({
  routes: [],
  events: {
    "task.settled"(event) {
      console.info("task settled", { status: event.status, taskId: event.taskId });
    },
  },
});
