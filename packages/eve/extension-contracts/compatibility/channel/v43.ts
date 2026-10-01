import { defineChannel } from "#public/channels/index.js";

// Epoch 43 channels had no `task.activity` event; epoch 44 adds an optional
// handler for it. A channel without one never receives it, so its task events
// still work.
export default defineChannel({
  routes: [],
  events: {
    "task.started"(event) {
      console.info("task started", { name: event.name, taskId: event.taskId });
    },
    "task.settled"(event) {
      console.info("task settled", { name: event.name, status: event.status });
    },
  },
});
