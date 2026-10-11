import { defineHook } from "#public/hooks/index.js";

// Epoch 43 callbacks that do not inspect a replacement predecessor remain supported.
export default defineHook({
  events: {
    "action.result"(event) {
      const { result } = event.data;
      if (result.kind !== "load-skill-result") return;
      console.info("skill loaded", { callId: result.callId, skill: result.name });
    },
  },
});
