import { defineChannel } from "#public/channels/index.js";

// Epoch 42 channels could observe a model step only once it finished; epoch 43
// adds an optional `step.started` handler. Channels without one see no change.
export default defineChannel({
  routes: [],
  events: {
    "step.completed"(event) {
      console.info("step completed", { finishReason: event.finishReason, turnId: event.turnId });
    },
  },
});
