import { defineHook } from "#public/hooks/index.js";

// Epoch 42 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 43 adds `name` to `load-skill`
// requests and requires it on results. Hooks that read the result's name keep working.
export default defineHook({
  events: {
    "action.result"(event) {
      const { result } = event.data;
      if (result.kind !== "load-skill-result") return;
      console.info("skill loaded", { callId: result.callId, skill: result.name });
    },
  },
});
