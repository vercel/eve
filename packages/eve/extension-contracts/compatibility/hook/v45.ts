import { defineHook } from "#public/hooks/index.js";

// Epoch 45 `action.result` errors had no `name`; epoch 46 adds it as optional.
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
