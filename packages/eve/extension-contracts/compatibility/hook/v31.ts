import { defineHook } from "#public/hooks/index.js";

// Epoch 31 tool-call action requests had no `parentCallId`; epoch 32 adds it
// as optional for nested actions. Hooks that read tool calls keep working.
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
