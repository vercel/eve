// Epoch 47 of the hook capability: the authoring contract of epoch 46 still compiles.
// Epoch 48 adds an optional `windows` usage field to subagent results.
import { defineHook } from "#public/hooks/index.js";

// Hooks that read the failure code and message keep working.
export default defineHook({
  events: {
    "action.result"(event) {
      const { error } = event.data;
      if (error === undefined) return;
      console.info("action failed", { code: error.code, message: error.message });
    },
  },
});
