import { defineChannel } from "#public/channels/index.js";

// Epoch 55 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 56 adds `name` to `load-skill`
// requests and requires it on results. Channels that read the result's name keep working.
export default defineChannel({
  routes: [],
  events: {
    "action.result"(event) {
      if (event.result.kind !== "load-skill-result") return;
      console.info("skill loaded", { callId: event.result.callId, skill: event.result.name });
    },
  },
});
