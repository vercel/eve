import { defineChannel } from "#public/channels/index.js";

// Epoch 52 tool-call action requests could carry `parentCallId` for nested
// actions; epoch 53 drops it, since connection tools no longer report them.
export default defineChannel({
  routes: [],
  events: {
    "actions.requested"(event) {
      for (const action of event.actions) {
        if (action.kind !== "tool-call") continue;
        console.info("tool requested", { callId: action.callId, toolName: action.toolName });
      }
    },
  },
});
