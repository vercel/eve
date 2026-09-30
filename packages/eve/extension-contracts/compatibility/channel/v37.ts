import { defineChannel } from "#public/channels/index.js";

// Epoch 37 channels had no `task.started`, `task.settled`, `turn.waiting`, or `input.resolved`
// handlers, which are additive, and could pass an `activityObserver` that eve now ignores.
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
