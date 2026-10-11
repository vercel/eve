import { defineHook } from "#public/hooks/index.js";

// Epoch 33 `task.settled` events had no `name` or `kind`; epoch 34 adds both
// as optional. Hooks that pair settled calls with `task.started` keep working.
export default defineHook({
  events: {
    "task.settled"(event) {
      console.info("task settled", { callId: event.data.callId, status: event.data.status });
    },
  },
});
