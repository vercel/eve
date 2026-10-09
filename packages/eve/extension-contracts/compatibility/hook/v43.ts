import { defineHook } from "#public/hooks/index.js";

// Epoch 43 hook contexts had no `position`; epoch 44 adds the position of the line each
// event was written in. Hooks that read events keep working.
export default defineHook({
  events: {
    "action.result"(event) {
      const { result } = event.data;
      if (result.kind !== "load-skill-result") return;
      console.info("skill loaded", { callId: result.callId, skill: result.name });
    },
  },
});
