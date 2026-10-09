import { defineHook } from "#public/hooks/index.js";

// Epoch 41 tool-call action requests could carry `parentCallId` for nested
// actions; epoch 42 drops it, since connection tools no longer report them.
// Hooks that read tool calls keep working.
export default defineHook({
  events: {
    "actions.requested"(event) {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        console.info("tool requested", { callId: action.callId, toolName: action.toolName });
      }
    },
  },
});
