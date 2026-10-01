import { defineHook } from "#public/hooks/index.js";

// Epoch 35 hooks had no `task.activity` event; epoch 36 adds it. A hook that
// doesn't subscribe to it never runs for it.
export default defineHook({
  events: {
    "task.started"(event, ctx) {
      console.info("task started", { sessionId: ctx.session.id, taskId: event.data.taskId });
    },
  },
});
