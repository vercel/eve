import { defineHook } from "#public/hooks/index.js";

// Epoch 34 `turn.failed` events had no `terminal`; epoch 35 adds it as optional.
// Hooks that read failed turns keep working.
export default defineHook({
  events: {
    "turn.failed"(event) {
      console.info("turn failed", { code: event.data.code, turnId: event.data.turnId });
    },
  },
});
