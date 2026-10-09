import { defineChannel } from "#public/channels/index.js";

// Epoch 56 sessions had no `getLineStream`; epoch 57 adds it, and handlers observe each
// event after its line is written. Handlers keep their event keys and arguments.
export default defineChannel({
  routes: [],
  events: {
    "action.result"(event) {
      if (event.result.kind !== "load-skill-result") return;
      console.info("skill loaded", { callId: event.result.callId, skill: event.result.name });
    },
  },
});
