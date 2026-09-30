import { defineChannel } from "#public/channels/index.js";

// Epoch 37 channels had no `task.started`, `task.settled`, or `turn.waiting` handlers; they are additive.
export default defineChannel({
  routes: [],
  events: {
    "turn.started"(event) {
      console.info("turn started", { turnId: event.turnId });
    },
    "turn.completed"(event) {
      console.info("turn completed", { turnId: event.turnId });
    },
  },
});
